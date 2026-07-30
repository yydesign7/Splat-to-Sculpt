import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, access, copyFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  buildCleanupPassthroughResult,
  shouldPassthroughOnBlenderFailure,
  type BlenderScriptResult,
} from '@/lib/blender-cleanup-fallback';
import { checkBlenderCommand, resolveBlenderCommand } from '@/lib/check-python-deps';
import {
  buildEphemeralFileUrl,
  getEphemeralSessionFromRequest,
  getSessionRoot,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';

const execFileAsync = promisify(execFile);

function parseBlenderJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

function getExecOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as { stdout?: string | Buffer; stderr?: string | Buffer })[key];
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function getExecCode(error: unknown): number | string | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { code?: number | string | null }).code;
  return value ?? null;
}

function getExecSignal(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { signal?: string | null }).signal;
  return value ?? null;
}

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

    let stdout = '';
    let stderr = '';
    let result: Record<string, unknown> | null = null;
    try {
      const output = await execFileAsync(blenderCommand, [
        '--background',
        '--python', blenderScript,
        '--',
        '--input', modelServerPath,
        '--output-dir', outputDir,
      ], {
        timeout: 300000, // 5 min
        env: { ...process.env },
      });
      stdout = output.stdout;
      stderr = output.stderr;
      result = parseBlenderJson(stdout);
    } catch (execError: unknown) {
      stdout = getExecOutput(execError, 'stdout');
      stderr = getExecOutput(execError, 'stderr');
      result = parseBlenderJson(stdout);
      if (
        shouldPassthroughOnBlenderFailure({
          message: execError instanceof Error ? execError.message : undefined,
          code: getExecCode(execError),
          signal: getExecSignal(execError),
          stdout,
          stderr,
          parsedScriptResult: result as BlenderScriptResult | null,
        })
      ) {
        const passthroughPath = path.join(outputDir, path.basename(modelServerPath));
        await copyFile(modelServerPath, passthroughPath);
        result = buildCleanupPassthroughResult(passthroughPath);
        console.warn('[blender-organize] Blender crashed before cleanup; using original model passthrough.');
      } else if (!result) {
        throw execError;
      }
    }

    if (!result) {
      const lines = stdout.trim().split('\n');
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
      cleanupPassthrough: result.cleanup_passthrough === true,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Blender model cleanup failed';
    console.error('[blender-organize] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
