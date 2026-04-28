import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, access } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { checkPythonDeps } from '@/lib/check-python-deps';
import {
  buildEphemeralFileUrl,
  getEphemeralSessionFromRequest,
  getSessionRoot,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';

const execFileAsync = promisify(execFile);

/**
 * POST /api/process-obj
 *
 * Process an OBJ model with a PNG texture: apply texture, complete UV,
 * export as OBJ and optionally as GLB.
 *
 * For GLB input, use /api/process-glb instead.
 *
 * Body:
 * {
 *   modelUrl: string,        // public URL path to model file
 *   textureUrl: string,      // public URL path to PNG texture
 *   outputFormat?: string,   // 'obj' (default) or 'glb'
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const { modelUrl, textureUrl, outputFormat } = body as {
      modelUrl?: string;
      textureUrl?: string;
      outputFormat?: string;
    };

    if (!modelUrl) {
      return NextResponse.json({ error: 'No model file path provided' }, { status: 400 });
    }
    if (!textureUrl) {
      return NextResponse.json({ error: 'No PNG material file path provided' }, { status: 400 });
    }

    // GLB files should use /api/process-glb instead
    if (modelUrl.toLowerCase().endsWith('.glb')) {
      return NextResponse.json(
        { error: 'Please use /api/process-glb for GLB files' },
        { status: 400 }
      );
    }

    // Check Python dependencies before processing
    const depsError = await checkPythonDeps(['trimesh', 'pyrender', 'numpy', 'cv2']);
    if (depsError) {
      return NextResponse.json({ error: depsError }, { status: 503 });
    }

    let objServerPath: string;
    let textureServerPath: string;
    try {
      objServerPath = resolveClientMediaUrlToFilesystem(modelUrl);
      textureServerPath = resolveClientMediaUrlToFilesystem(textureUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid model or texture path' }, { status: 400 });
    }

    // Validate that model file exists on server
    try {
      await access(objServerPath);
    } catch {
      return NextResponse.json(
        { error: `Model file not found: ${modelUrl}. If recently uploaded, please wait for upload to complete.` },
        { status: 400 }
      );
    }

    // Validate texture file
    try {
      await access(textureServerPath);
    } catch {
      return NextResponse.json(
        { error: `Texture file not found: ${textureUrl}` },
        { status: 400 }
      );
    }

    const jobId = randomUUID();
    const outputDir = path.join(getSessionRoot(sessionId), 'obj-processed', jobId);
    await mkdir(outputDir, { recursive: true });

    // Run Python processing script
    const scriptPath = path.join(process.cwd(), 'scripts', 'obj_process.py');
    const scriptArgs = [
      scriptPath,
      '--input', objServerPath,
      '--texture', textureServerPath,
      '--output-dir', outputDir,
    ];
    // Skip GLB generation when outputFormat is 'obj'
    if (outputFormat === 'obj') {
      scriptArgs.push('--no-glb');
    }
    const { stdout, stderr } = await execFileAsync('python3', scriptArgs, {
      timeout: 300000, // 5 min timeout
      env: { ...process.env, PYOPENGL_PLATFORM: 'egl' },
    });

    // Parse JSON from last line of stdout
    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const result = JSON.parse(lastLine);

    if (result.status === 'error') {
      console.error('[process-obj] Script error:', result.error);
      console.error('[process-obj] stderr:', stderr?.slice(-500));
      return NextResponse.json({ error: result.error || 'OBJ processing failed' }, { status: 500 });
    }

    const modelFileName = path.basename(result.new_model_path);
    const outputUrl = buildEphemeralFileUrl(sessionId, `obj-processed/${jobId}/${modelFileName}`);

    const glbUrl = result.new_glb_path
      ? buildEphemeralFileUrl(sessionId, `obj-processed/${jobId}/${path.basename(result.new_glb_path)}`)
      : null;

    const renderUrl = result.render_path
      ? buildEphemeralFileUrl(sessionId, `obj-processed/${jobId}/${path.basename(result.render_path)}`)
      : null;

    return NextResponse.json({
      success: true,
      modelUrl: outputUrl,
      glbUrl,
      renderUrl,
      vertexCount: result.vertex_count,
      faceCount: result.face_count,
      uvSource: result.uv_source,
      textures: result.textures,
      annotations: result.annotations,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'OBJ processing failed';
    const stderr = (error as { stderr?: string })?.stderr || '';
    console.error('[process-obj] Error:', message, stderr ? `\nstderr: ${stderr.slice(-500)}` : '');
    // Extract error from stdout if available
    const stdout = (error as { stdout?: string })?.stdout || '';
    const lines = stdout.trim().split('\n');
    let scriptError = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.error) scriptError = parsed.error;
        } catch { /* ignore */ }
        break;
      }
    }
    return NextResponse.json({ error: scriptError || message }, { status: 500 });
  }
}
