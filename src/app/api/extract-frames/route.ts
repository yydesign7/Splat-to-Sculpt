import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, rm, readdir, copyFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { checkSystemCommand } from '@/lib/check-python-deps';
import {
  buildEphemeralFileUrl,
  ensureSessionRoot,
  getEphemeralSessionFromRequest,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  let tempDir = '';
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const { videoPath, frameCount: rawFrameCount } = body as {
      videoPath?: string;
      frameCount?: number;
    };

    if (!videoPath) {
      return NextResponse.json({ error: 'No video path provided' }, { status: 400 });
    }

    const depsError = await checkSystemCommand('ffmpeg');
    if (depsError) {
      return NextResponse.json({ error: depsError }, { status: 503 });
    }

    const frameCount = Math.max(1, Math.min(300, rawFrameCount || 120));

    let serverVideoPath: string;
    try {
      serverVideoPath = resolveClientMediaUrlToFilesystem(videoPath);
    } catch {
      return NextResponse.json({ error: 'Invalid video path' }, { status: 400 });
    }

    const jobId = randomUUID();
    tempDir = path.join('/tmp', `frames_${jobId}`);
    await mkdir(tempDir, { recursive: true });

    let duration = 0;
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          serverVideoPath,
        ],
        { timeout: 10000 },
      );
      duration = parseFloat(stdout.trim());
    } catch {
      duration = 10;
    }

    if (duration <= 0) duration = 10;

    const fps = frameCount / duration;

    const outputPath = path.join(tempDir, 'frame_%04d.jpg');
    await execFileAsync(
      'ffmpeg',
      ['-i', serverVideoPath, '-vf', `fps=${fps.toFixed(6)}`, '-q:v', '2', '-y', outputPath],
      { timeout: 120000 },
    );

    const files = await readdir(tempDir);
    const frameFiles = files.filter((f) => f.startsWith('frame_') && f.endsWith('.jpg')).sort();

    if (frameFiles.length === 0) {
      return NextResponse.json({ error: 'No frames could be extracted' }, { status: 500 });
    }

    const sessionRoot = await ensureSessionRoot(sessionId);
    const framesDir = path.join(sessionRoot, 'frames', jobId);
    await mkdir(framesDir, { recursive: true });

    const frameUrls: string[] = [];
    for (const frameFile of frameFiles) {
      const srcPath = path.join(tempDir, frameFile);
      const destPath = path.join(framesDir, frameFile);
      await copyFile(srcPath, destPath);
      frameUrls.push(buildEphemeralFileUrl(sessionId, `frames/${jobId}/${frameFile}`));
    }

    await rm(tempDir, { recursive: true, force: true });

    return NextResponse.json({
      success: true,
      frameCount: frameUrls.length,
      outputFolder: jobId,
      frames: frameUrls,
    });
  } catch (error: unknown) {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    const message = error instanceof Error ? error.message : 'Frame extraction failed';
    console.error('[extract-frames] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
