import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { mkdir } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  buildEphemeralFileUrl,
  getSessionRoot,
  isValidEphemeralSessionId,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';

function runThumbnailScript(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.PYTHON_BIN || 'python3',
      args,
      {
        timeout: 60_000,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/private/tmp/studio3dgs-matplotlib',
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/private/tmp/studio3dgs-cache',
        },
      },
      (err, stdout, stderr) => {
        const out = stdout?.toString() ?? '';
        const errS = stderr?.toString() ?? '';
        if (err) {
          (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout = out;
          (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stderr = errS;
          reject(err);
          return;
        }
        resolve({ stdout: out, stderr: errS });
      }
    );
  });
}

function parseScriptResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const start = lines[i]!.lastIndexOf('{');
    if (start < 0) continue;
    try {
      const value = JSON.parse(lines[i]!.slice(start)) as Record<string, unknown>;
      if (value && typeof value.status === 'string') return value;
    } catch {
      // Continue scanning earlier lines.
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { fileUrl, ephemeralSessionId } = body as {
      fileUrl?: string;
      ephemeralSessionId?: string | null;
    };

    if (!fileUrl) {
      return NextResponse.json({ error: 'Missing fileUrl' }, { status: 400 });
    }
    if (!isValidEphemeralSessionId(ephemeralSessionId)) {
      return NextResponse.json({ error: 'Missing or invalid ephemeralSessionId' }, { status: 400 });
    }

    const sourcePath = resolveClientMediaUrlToFilesystem(fileUrl);
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext !== '.ply') {
      return NextResponse.json({ error: `Unsupported thumbnail source: ${ext || 'unknown'}` }, { status: 400 });
    }

    const jobId = randomUUID();
    const relPath = `asset-thumbnails/${jobId}/thumbnail.png`;
    const outputPath = path.join(getSessionRoot(ephemeralSessionId), relPath);
    await mkdir(path.dirname(outputPath), { recursive: true });

    const scriptPath = path.join(process.cwd(), 'scripts', 'render_ply_thumbnail.py');
    const { stdout, stderr } = await runThumbnailScript([
      scriptPath,
      '--input',
      sourcePath,
      '--output',
      outputPath,
      '--width',
      '144',
      '--height',
      '96',
    ]);
    if (stderr.trim()) {
      console.error('[generate-asset-thumbnail] stderr:', stderr.slice(-4000));
    }

    const result = parseScriptResult(stdout);
    if (!result || result.status !== 'ok') {
      const message =
        (result && typeof result.error === 'string' && result.error) ||
        `Thumbnail script failed. stdout: ${stdout.slice(-1000) || '(empty)'}`;
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      thumbnailUrl: buildEphemeralFileUrl(ephemeralSessionId, relPath),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to generate thumbnail';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
