import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, access } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { checkBlenderCommand, resolveBlenderCommand } from '@/lib/check-python-deps';
import {
  buildEphemeralFileUrl,
  getEphemeralSessionFromRequest,
  getSessionRoot,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';

const execFileAsync = promisify(execFile);

/**
 * POST /api/blender-organize
 *
 * Organize (clean up) a 3D model (OBJ/GLB/GLTF/FBX) using Blender:
 * - Remove loose geometry
 * - Merge duplicate vertices
 * - Dissolve degenerate faces
 * - Recalculate normals
 * - Fill holes
 *
 * Body:
 * { modelUrl: string }  // public URL path to 3D model (OBJ, GLB, etc.)
 */
export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const inputModelUrl = (body as { modelUrl?: string }).modelUrl;

    if (!inputModelUrl) {
      return NextResponse.json({ error: 'No model file path provided' }, { status: 400 });
    }

    // Check system dependencies before processing
    const depsError = await checkBlenderCommand();
    if (depsError) {
      return NextResponse.json({ error: depsError }, { status: 503 });
    }

    let modelServerPath: string;
    try {
      modelServerPath = resolveClientMediaUrlToFilesystem(inputModelUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid model path' }, { status: 400 });
    }

    try {
      await access(modelServerPath);
    } catch {
      return NextResponse.json(
        { error: `Model file not found: ${inputModelUrl}. If recently uploaded, please wait for upload to complete.` },
        { status: 400 }
      );
    }

    const jobId = randomUUID();
    const outputDir = path.join(getSessionRoot(sessionId), 'blender-organized', jobId);
    await mkdir(outputDir, { recursive: true });

    // Run Blender organize script
    const blenderScript = path.join(process.cwd(), 'scripts', 'blender_organize.py');
    const blenderCommand = await resolveBlenderCommand();

    if (!blenderCommand) {
      return NextResponse.json({ error: 'Blender executable not found' }, { status: 503 });
    }

    const { stdout, stderr } = await execFileAsync(blenderCommand, [
      '--background',
      '--python', blenderScript,
      '--',
      '--input', modelServerPath,
      '--output-dir', outputDir,
    ], {
      timeout: 300000, // 5 min
      env: { ...process.env },
    });

    // Parse JSON from Blender output (last line starting with '{')
    const lines = stdout.trim().split('\n');
    let result: Record<string, unknown> | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{')) {
        try {
          result = JSON.parse(line);
          break;
        } catch {
          continue;
        }
      }
    }

    if (!result) {
      console.error('[blender-organize] Failed to parse output. Last lines:', lines.slice(-5));
      console.error('[blender-organize] stderr:', stderr?.slice(-500));
      return NextResponse.json({ error: 'Failed to parse Blender output' }, { status: 500 });
    }

    if (result.status === 'error') {
      return NextResponse.json({ error: result.error || 'Blender model cleanup failed' }, { status: 500 });
    }

    const modelUrl = result.obj_path
      ? buildEphemeralFileUrl(sessionId, `blender-organized/${jobId}/${path.basename(result.obj_path as string)}`)
      : null;

    const glbUrl = result.glb_path
      ? buildEphemeralFileUrl(sessionId, `blender-organized/${jobId}/${path.basename(result.glb_path as string)}`)
      : null;

    return NextResponse.json({
      success: true,
      modelUrl,
      glbUrl,
      vertexCountBefore: result.vertex_count_before,
      vertexCountAfter: result.vertex_count_after,
      faceCountBefore: result.face_count_before,
      faceCountAfter: result.face_count_after,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Blender model cleanup failed';
    console.error('[blender-organize] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
