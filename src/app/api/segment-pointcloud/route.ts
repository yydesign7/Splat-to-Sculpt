import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile, mkdir, stat } from 'fs/promises';
import path from 'path';
import {
  buildEphemeralFileUrl,
  getEphemeralSessionFromRequest,
  getSessionRoot,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';

const execFileAsync = promisify(execFile);

function toClientMediaUrl(sessionId: string, absFile: string): string {
  const sessionRoot = path.normalize(getSessionRoot(sessionId));
  const abs = path.normalize(absFile);
  const sep = sessionRoot.endsWith(path.sep) ? sessionRoot : `${sessionRoot}${path.sep}`;
  if (abs === sessionRoot || abs.startsWith(sep)) {
    const rel = path.relative(sessionRoot, abs).replace(/\\/g, '/');
    return buildEphemeralFileUrl(sessionId, rel);
  }
  const publicDir = path.join(process.cwd(), 'public');
  const pubNorm = path.normalize(publicDir);
  const pubSep = pubNorm.endsWith(path.sep) ? pubNorm : `${pubNorm}${path.sep}`;
  if (abs === pubNorm || abs.startsWith(pubSep)) {
    return `/${path.relative(pubNorm, abs).replace(/\\/g, '/')}`;
  }
  return abs;
}

export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const { plyPath, mode = 'remove_background' } = body;

    if (!plyPath) {
      return NextResponse.json({ error: 'No PLY path provided' }, { status: 400 });
    }

    let inputPath: string;
    try {
      inputPath = resolveClientMediaUrlToFilesystem(plyPath);
    } catch {
      return NextResponse.json({ error: 'Invalid PLY path' }, { status: 400 });
    }

    try {
      await stat(inputPath);
    } catch {
      return NextResponse.json({ error: 'Input PLY file not found' }, { status: 404 });
    }

    const outputDir = path.join(path.dirname(inputPath), 'segmented');
    const outputPly = path.join(outputDir, 'output.ply');
    const layersDir = path.join(outputDir, 'layers');
    const scriptPath = path.join(process.cwd(), 'scripts', 'pointcloud_segment.py');

    console.log(`[segment-pointcloud] Running segmentation: mode=${mode}, input=${inputPath}`);

    const args = [
      scriptPath,
      '--input', inputPath,
      '--output_ply', outputPly,
      '--layers_dir', layersDir,
      '--mode', mode,
    ];

    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync('python3', args, { timeout: 300_000 });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      stdout = error.stdout || '';
      stderr = error.stderr || '';
      console.error(`[segment-pointcloud] Script error: ${error.message}`);
      console.error(`[segment-pointcloud] stderr: ${stderr}`);

      return NextResponse.json({
        success: true,
        segmented: false,
        plyUrl: plyPath,
        layerFiles: [],
        layerNames: [],
        message: 'Segmentation failed, using original PLY',
      });
    }

    if (stdout) console.log(`[segment-pointcloud] stdout: ${stdout}`);
    if (stderr) console.error(`[segment-pointcloud] stderr: ${stderr}`);

    const layerFiles: string[] = [];
    const layerNames: string[] = [];
    let mainPlyUrl = plyPath;

    try {
      const mainStat = await stat(outputPly);
      if (mainStat.size > 100) {
        mainPlyUrl = toClientMediaUrl(sessionId, outputPly);
      }
    } catch {
      // Main output not found, use original
    }

    try {
      const files = await readdir(layersDir);
      const layerPlyFiles = files.filter((f) => f.startsWith('layer_') && f.endsWith('.ply')).sort();

      for (const f of layerPlyFiles) {
        const absPath = path.join(layersDir, f);
        layerFiles.push(toClientMediaUrl(sessionId, absPath));
      }

      try {
        const metaRaw = await readFile(path.join(layersDir, 'layers_meta.json'), 'utf-8');
        const meta = JSON.parse(metaRaw);
        if (meta.layers && Array.isArray(meta.layers)) {
          for (const layer of meta.layers) {
            layerNames.push(layer.name || 'unknown');
          }
        }
      } catch {
        for (const f of layerPlyFiles) {
          const match = f.match(/^layer_(\d+)_(.+)\.ply$/);
          if (match) {
            layerNames.push(match[2]);
          } else {
            layerNames.push(f.replace('.ply', ''));
          }
        }
      }
    } catch {
      console.warn('[segment-pointcloud] No output directory found, using original PLY');
    }

    console.log(`[segment-pointcloud] Done. mainPly=${mainPlyUrl}, layers=${layerFiles.length}, names=${layerNames.join(',')}`);

    return NextResponse.json({
      success: true,
      segmented: true,
      plyUrl: mainPlyUrl,
      layerFiles,
      layerNames,
      originalPlyUrl: plyPath,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Segmentation failed';
    console.error(`[segment-pointcloud] Error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
