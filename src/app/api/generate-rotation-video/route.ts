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
 * POST /api/generate-rotation-video
 *
 * Generate a 360° rotation video from a 3D model (OBJ/GLB/FBX/PLY).
 *
 * Body:
 * {
 *   modelUrl: string,       // public URL path to 3D model file
 *   fps?: number,           // frame rate (default: 30)
 *   duration?: number,      // duration in seconds (default: 6)
 *   width?: number,         // video width (default: 512)
 *   height?: number,        // video height (default: 512)
 *   lightParams?: {         // optional light parameters
 *     ambientIntensity: number,
 *     mainLightIntensity: number,
 *     mainLightColor: [number, number, number],
 *     mainLightAzimuth: number,
 *     mainLightElevation: number,
 *     fillLightIntensity: number,
 *     fillLightAzimuth: number,
 *     fillLightElevation: number,
 *     exposure: number,
 *   }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const { modelUrl, fps, duration, width, height, lightParams } = body as {
      modelUrl?: string;
      fps?: number;
      duration?: number;
      width?: number;
      height?: number;
      lightParams?: {
        ambientIntensity?: number;
        mainLightIntensity?: number;
        mainLightColor?: [number, number, number];
        mainLightAzimuth?: number;
        mainLightElevation?: number;
        fillLightIntensity?: number;
        fillLightAzimuth?: number;
        fillLightElevation?: number;
        exposure?: number;
      };
    };

    if (!modelUrl) {
      return NextResponse.json({ error: 'No model file path provided' }, { status: 400 });
    }

    // Check Python dependencies before processing
    const depsError = await checkPythonDeps(['trimesh', 'numpy']);
    if (depsError) {
      return NextResponse.json({ error: depsError }, { status: 503 });
    }

    let modelServerPath: string;
    try {
      modelServerPath = resolveClientMediaUrlToFilesystem(modelUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid model path' }, { status: 400 });
    }

    try {
      await access(modelServerPath);
    } catch {
      return NextResponse.json(
        { error: `Model file not found: ${modelUrl}. If recently uploaded, please wait for upload to complete.` },
        { status: 400 }
      );
    }

    const jobId = randomUUID();
    const outputDir = path.join(getSessionRoot(sessionId), 'rotation-videos', jobId);
    await mkdir(outputDir, { recursive: true });

    const scriptPath = path.join(process.cwd(), 'scripts', 'generate_rotation_video.py');

    const args = [
      scriptPath,
      '--model', modelServerPath,
      '--output-dir', outputDir,
      '--fps', String(fps || 30),
      '--duration', String(duration || 6),
      '--width', String(width || 512),
      '--height', String(height || 512),
    ];

    // Pass light params as JSON string
    if (lightParams && Object.keys(lightParams).length > 0) {
      args.push('--light-params', JSON.stringify(lightParams));
    }

    const { stdout, stderr } = await execFileAsync('python3', args, {
      timeout: 600_000, // 10 min — matplotlib fallback on macOS is CPU-heavy
      env: { ...process.env },
    });

    // Parse JSON from script output (last line)
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
      console.error('[generate-rotation-video] Failed to parse output. Last lines:', lines.slice(-5));
      console.error('[generate-rotation-video] stderr:', stderr?.slice(-500));
      return NextResponse.json({ error: 'Failed to parse video generation script output' }, { status: 500 });
    }

    if (result.status === 'error') {
      console.error('[generate-rotation-video] Script error:', result.error);
      return NextResponse.json({ error: result.error || 'Video generation failed' }, { status: 500 });
    }

    const videoUrl = result.video_path
      ? buildEphemeralFileUrl(sessionId, `rotation-videos/${jobId}/${path.basename(result.video_path as string)}`)
      : null;

    return NextResponse.json({
      success: true,
      videoUrl,
      totalFrames: result.total_frames || 0,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Video generation failed';
    console.error('[generate-rotation-video] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
