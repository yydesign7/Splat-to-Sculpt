import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { mkdir } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { setTask } from '@/lib/mesh-task-store';
import { checkPythonDeps } from '@/lib/check-python-deps';
import {
  buildEphemeralFileUrl,
  getSessionRoot,
  isValidEphemeralSessionId,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';

/** gs_to_mesh prints one JSON object per result; tolerate log prefixes and trailing noise on the same line. */
function isMeshResultJson(v: Record<string, unknown>): boolean {
  return typeof v.status === 'string';
}

/** Find gs_to_mesh JSON on stdout: last valid line with optional prefix before `{`, then tail slice fallback. */
function parseMeshScriptJson(
  rawStdout: string
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const lines = rawStdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    let searchEnd = line.length;
    while (searchEnd > 0) {
      const j = line.lastIndexOf('{', searchEnd - 1);
      if (j === -1) break;
      try {
        const value = JSON.parse(line.slice(j)) as Record<string, unknown>;
        if (value && typeof value === 'object' && !Array.isArray(value) && isMeshResultJson(value)) {
          return { ok: true, value };
        }
      } catch {
        /* try earlier `{` on this line */
      }
      searchEnd = j;
    }
  }

  const lastBrace = rawStdout.lastIndexOf('{');
  if (lastBrace !== -1) {
    const tail = rawStdout.slice(lastBrace);
    const close = tail.lastIndexOf('}');
    if (close > 0) {
      try {
        const value = JSON.parse(tail.slice(0, close + 1)) as Record<string, unknown>;
        if (value && typeof value === 'object' && !Array.isArray(value) && isMeshResultJson(value)) {
          return { ok: true, value };
        }
      } catch {
        /* noop */
      }
    }
  }

  return { ok: false, reason: 'No valid JSON result line in gs_to_mesh output' };
}

function runGsToMesh(
  args: string[],
  options: { timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      args,
      { ...options, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = stdout?.toString() ?? '';
        const errS = stderr?.toString() ?? '';
        if (err) {
          (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout = out;
          (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stderr = errS;
        }
        if (err) reject(err);
        else resolve({ stdout: out, stderr: errS });
      }
    );
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { plyUrl, outputFormat, ephemeralSessionId } = body as {
    plyUrl?: string;
    outputFormat?: string;
    ephemeralSessionId?: string;
    reconstructionProfile?: string;
  };

  if (!plyUrl) {
    return NextResponse.json({ error: 'No point cloud file path provided' }, { status: 400 });
  }
  if (!isValidEphemeralSessionId(ephemeralSessionId)) {
    return NextResponse.json({ error: 'Missing or invalid ephemeralSessionId' }, { status: 400 });
  }

  const format = outputFormat || 'glb';
  if (!['glb', 'obj', 'ply'].includes(format)) {
    return NextResponse.json({ error: 'Unsupported output format' }, { status: 400 });
  }
  const reconstructionProfile = typeof body.reconstructionProfile === 'string'
    ? body.reconstructionProfile
    : 'auto';
  const validReconstructionProfiles = new Set([
    'auto',
    'default',
    'default_general',
    'closed_solid',
    'thin_structure',
    'flat_panel',
    'high_detail_ornamental',
    'noisy_scan',
  ]);
  if (!validReconstructionProfiles.has(reconstructionProfile)) {
    return NextResponse.json({ error: 'Unsupported reconstruction profile' }, { status: 400 });
  }

  // Check Python dependencies before starting the task
  const depsError = await checkPythonDeps(['open3d', 'numpy']);
  if (depsError) {
    return NextResponse.json({ error: depsError }, { status: 503 });
  }

  const taskId = randomUUID();
  await setTask(taskId, {
    status: 'processing',
    progress: 'Initializing...',
    ephemeralSessionId,
  });

  // Run mesh generation asynchronously
  runMeshPipeline(taskId, plyUrl, format, ephemeralSessionId, reconstructionProfile).catch(() => {});

  return NextResponse.json({
    success: true,
    taskId,
    message: 'Mesh generation task started',
  });
}

async function runMeshPipeline(
  taskId: string,
  plyUrl: string,
  outputFormat: string,
  ephemeralSessionId: string,
  reconstructionProfile: string,
) {
  try {
    await setTask(taskId, { progress: 'Preparing point cloud data...' });

    const plyServerPath = resolveClientMediaUrlToFilesystem(plyUrl);

    const meshJobId = randomUUID();
    const outputDir = path.join(getSessionRoot(ephemeralSessionId), 'meshes', meshJobId);
    await mkdir(outputDir, { recursive: true });

    await setTask(taskId, { progress: 'Selecting reconstruction profile...' });

    // Run Python mesh generation script
    const scriptPath = path.join(process.cwd(), 'scripts', 'gs_to_mesh.py');
    const { stdout, stderr: stderrText } = await runGsToMesh(
      [
        scriptPath,
        '--input',
        plyServerPath,
        '--output-dir',
        outputDir,
        '--format',
        outputFormat,
        '--reconstruction-profile',
        reconstructionProfile,
      ],
      { timeout: 300_000 }
    );
    if (stderrText?.trim()) {
      console.error('[generate-mesh] python stderr (tail):\n', stderrText.slice(-8000));
    }

    const parsed = parseMeshScriptJson(stdout);
    if (!parsed.ok) {
      const extra = `stdout (tail): ${stdout.slice(-2000) || '(empty)'}; stderr (tail): ${(stderrText || '').slice(-2000) || '(empty)'}`;
      console.error('[generate-mesh]', parsed.reason, extra);
      await setTask(taskId, {
        status: 'error',
        error: `${parsed.reason}. Check server log for full gs_to_mesh output.`,
      });
      return;
    }

    const result = parsed.value;
    if (result.status === 'error') {
      const msg =
        (typeof result.error === 'string' && result.error) || 'Mesh generation failed';
      const detail =
        typeof result.traceback === 'string' && result.traceback
          ? `\n${(result.traceback as string).slice(0, 2000)}`
          : '';
      if (result.traceback) {
        console.error('[generate-mesh] Python error:', msg, '\n', String(result.traceback).slice(0, 4000));
      } else {
        console.error('[generate-mesh] Python error:', msg);
      }
      await setTask(taskId, { status: 'error', error: `${msg}${detail}`.trim() });
      return;
    }

    // The script outputs the server-side path; convert to URL path
    const outPath = result.outputPath;
    if (typeof outPath !== 'string' || !outPath) {
      await setTask(taskId, { status: 'error', error: 'Mesh script returned no outputPath' });
      return;
    }
    const outputFileName = path.basename(outPath);
    const meshUrl = buildEphemeralFileUrl(ephemeralSessionId, `meshes/${meshJobId}/${outputFileName}`);

    await setTask(taskId, {
      status: 'done',
      progress: 'Done',
      result: {
        meshUrl,
        meshFormat: outputFormat,
        faceCount: Number(result.faceCount) || 0,
        vertexCount: Number(result.vertexCount) || 0,
        reconstructionProfile: typeof result.reconstructionProfile === 'string'
          ? result.reconstructionProfile
          : reconstructionProfile,
        requestedReconstructionProfile: typeof result.requestedReconstructionProfile === 'string'
          ? result.requestedReconstructionProfile
          : reconstructionProfile,
      },
    });
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const fromStd = err.stdout?.toString() ?? '';
    const fromSerr = err.stderr?.toString() ?? '';
    if (fromStd.trim() || fromSerr.trim()) {
      console.error(
        '[generate-mesh] Process failed; stdout (tail):',
        fromStd.slice(-3000),
        'stderr (tail):',
        fromSerr.slice(-3000)
      );
    }
    const parsed = fromStd ? parseMeshScriptJson(fromStd) : null;
    if (parsed?.ok && parsed.value.status === 'error') {
      const msg = (typeof parsed.value.error === 'string' && parsed.value.error) || 'Mesh generation failed';
      const detail =
        typeof parsed.value.traceback === 'string' && parsed.value.traceback
          ? `\n${(parsed.value.traceback as string).slice(0, 2000)}`
          : '';
      await setTask(taskId, { status: 'error', error: `${msg}${detail}`.trim() });
      return;
    }
    const message = error instanceof Error ? error.message : 'Mesh generation failed';
    console.error('[generate-mesh] Error:', message);
    await setTask(taskId, {
      status: 'error',
      error: [message, fromSerr?.trim() && `stderr: ${fromSerr.slice(-2000)}`]
        .filter(Boolean)
        .join('\n'),
    });
  }
}
