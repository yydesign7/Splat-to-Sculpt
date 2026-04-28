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
 * POST /api/process-glb
 *
 * Process a GLB model with a PNG texture: apply texture to all meshes,
 * export as GLB (with embedded texture) and optionally as OBJ.
 *
 * Body:
 * {
 *   glbUrl: string,          // public URL path to GLB model file
 *   textureUrl: string,      // public URL path to PNG texture
 *   outputFormat?: string,   // 'glb' (default) or 'obj'
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const { glbUrl, textureUrl, outputFormat } = body as {
      glbUrl?: string;
      textureUrl?: string;
      outputFormat?: string;
    };

    if (!glbUrl) {
      return NextResponse.json({ error: 'No GLB model file path provided' }, { status: 400 });
    }
    if (!textureUrl) {
      return NextResponse.json({ error: 'No PNG material file path provided' }, { status: 400 });
    }

    // Check Python dependencies before processing
    const depsError = await checkPythonDeps(['trimesh', 'pyrender', 'numpy', 'cv2']);
    if (depsError) {
      return NextResponse.json({ error: depsError }, { status: 503 });
    }

    let glbServerPath: string;
    let textureServerPath: string;
    try {
      glbServerPath = resolveClientMediaUrlToFilesystem(glbUrl);
      textureServerPath = resolveClientMediaUrlToFilesystem(textureUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid glb or texture path' }, { status: 400 });
    }

    // Validate that model file exists on server
    try {
      await access(glbServerPath);
    } catch {
      return NextResponse.json(
        { error: `GLB model file not found: ${glbUrl}. If recently uploaded, please wait for upload to complete.` },
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
    const outputDir = path.join(getSessionRoot(sessionId), 'glb-processed', jobId);
    await mkdir(outputDir, { recursive: true });

    // Run Python GLB processing script
    const scriptPath = path.join(process.cwd(), 'scripts', 'glb_process.py');
    const scriptArgs = [
      scriptPath,
      '--input', glbServerPath,
      '--texture', textureServerPath,
      '--output-dir', outputDir,
    ];
    // Skip OBJ generation when outputFormat is 'glb' (default — GLB is the primary output)
    if (outputFormat !== 'obj') {
      scriptArgs.push('--no-obj');
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
      console.error('[process-glb] Script error:', result.error);
      console.error('[process-glb] stderr:', stderr?.slice(-500));
      return NextResponse.json({ error: result.error || 'GLB processing failed' }, { status: 500 });
    }

    const glbResultUrl = result.new_glb_path
      ? buildEphemeralFileUrl(sessionId, `glb-processed/${jobId}/${path.basename(result.new_glb_path)}`)
      : null;

    const modelUrl = result.new_model_path
      ? buildEphemeralFileUrl(sessionId, `glb-processed/${jobId}/${path.basename(result.new_model_path)}`)
      : null;

    const renderUrl = result.render_path
      ? buildEphemeralFileUrl(sessionId, `glb-processed/${jobId}/${path.basename(result.render_path)}`)
      : null;

    return NextResponse.json({
      success: true,
      glbUrl: glbResultUrl,
      modelUrl,
      renderUrl,
      vertexCount: result.vertex_count,
      faceCount: result.face_count,
      uvSource: result.uv_source,
      textures: result.textures,
      annotations: result.annotations,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'GLB processing failed';
    const stderr = (error as { stderr?: string })?.stderr || '';
    console.error('[process-glb] Error:', message, stderr ? `\nstderr: ${stderr.slice(-500)}` : '');
    // Extract Blender-friendly error from stdout if available
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
