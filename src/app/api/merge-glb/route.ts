import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, access, unlink } from 'fs/promises';
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

type MergeScriptResult = { status?: string; output_path?: string; error?: string };

function parseLastJsonLine(stdout: string): MergeScriptResult | null {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as MergeScriptResult;
    } catch {
      continue;
    }
  }
  return null;
}

function execFileStdout(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const o = err as { stdout?: string | Buffer };
  if (typeof o.stdout === 'string' && o.stdout.trim()) return o.stdout;
  if (Buffer.isBuffer(o.stdout) && o.stdout.length > 0) return o.stdout.toString('utf8');
  return undefined;
}

function execFileStderr(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const o = err as { stderr?: string | Buffer };
  if (typeof o.stderr === 'string' && o.stderr.trim()) return o.stderr;
  if (Buffer.isBuffer(o.stderr) && o.stderr.length > 0) return o.stderr.toString('utf8');
  return undefined;
}

/**
 * POST /api/merge-glb
 * Body: { glbPaths: string[] }  // public URL paths, e.g. /meshes/../*.glb
 * Optional: { names: string[] }  // one name per file (order-aligned)
 * Merges into a single glb under public/merged-glb/<jobId>/merged.glb
 */
export async function POST(request: NextRequest) {
  let inputJsonPath: string | null = null;
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const { glbPaths, names } = body as { glbPaths?: string[]; names?: string[] };
    if (!glbPaths || !Array.isArray(glbPaths) || glbPaths.length < 1) {
      return NextResponse.json({ error: 'glbPaths (non-empty array) is required' }, { status: 400 });
    }

    const depsError = await checkPythonDeps(['trimesh', 'numpy']);
    if (depsError) {
      return NextResponse.json({ error: depsError }, { status: 503 });
    }

    const absPaths: string[] = [];
    for (const p of glbPaths) {
      if (typeof p !== 'string') {
        return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
      }
      let ap: string;
      try {
        ap = resolveClientMediaUrlToFilesystem(p);
      } catch {
        return NextResponse.json({ error: `Invalid path: ${p}` }, { status: 400 });
      }
      try {
        await access(ap);
      } catch {
        return NextResponse.json({ error: `File not found: ${p}` }, { status: 400 });
      }
      absPaths.push(ap);
    }

    const jobId = randomUUID();
    const outDir = path.join(getSessionRoot(sessionId), 'merged-glb', jobId);
    await mkdir(outDir, { recursive: true });
    const outGlb = path.join(outDir, 'merged.glb');
    inputJsonPath = path.join(outDir, 'input.json');
    await writeFile(
      inputJsonPath,
      JSON.stringify({ paths: absPaths, names: names && names.length === glbPaths.length ? names : undefined })
    );

    const script = path.join(process.cwd(), 'scripts', 'merge_glbs.py');
    let stdout: string;
    let stderr: string;
    try {
      const out = await execFileAsync('python3', [script, '--out', outGlb, '--input-json', inputJsonPath], {
        timeout: 300_000,
        env: { ...process.env },
      });
      const rawOut = out.stdout ?? '';
      const rawErr = out.stderr ?? '';
      stdout = Buffer.isBuffer(rawOut) ? rawOut.toString('utf8') : String(rawOut);
      stderr = Buffer.isBuffer(rawErr) ? rawErr.toString('utf8') : String(rawErr);
    } catch (execErr: unknown) {
      const out = execFileStdout(execErr);
      const errOut = execFileStderr(execErr);
      const parsed = out ? parseLastJsonLine(out) : null;
      const scriptError = parsed?.error;
      const baseMsg = execErr instanceof Error ? execErr.message : 'merge-glb subprocess failed';

      if (scriptError) {
        console.error('[merge-glb] merge_glbs.py:', scriptError);
      } else if (out) {
        console.error('[merge-glb] merge_glbs stdout (last lines):\n', out.trim().split('\n').slice(-8).join('\n'));
      }
      if (errOut) {
        const tail = errOut.length > 2000 ? errOut.slice(-2000) : errOut;
        console.error('[merge-glb] merge_glbs stderr:', tail);
      }
      if (!scriptError && !out && !errOut) {
        console.error('[merge-glb]', baseMsg);
      }

      return NextResponse.json(
        {
          error: scriptError || baseMsg,
          mergeScriptError: scriptError ?? undefined,
          rawScriptStdout: out?.trim().split('\n').slice(-12).join('\n') || undefined,
        },
        { status: 500 }
      );
    }
    if (stderr) {
      const tail = typeof stderr === 'string' && stderr.length > 2000 ? stderr.slice(-2000) : stderr;
      if (String(stderr).toLowerCase().includes('error')) {
        console.warn('[merge-glb] stderr:', tail);
      }
    }
    const lines = stdout.trim().split('\n');
    const result = parseLastJsonLine(stdout);
    if (!result || result.status === 'error') {
      return NextResponse.json(
        { error: result?.error || 'merge_glbs failed', raw: lines.slice(-5) },
        { status: 500 }
      );
    }
    if (!result.output_path) {
      return NextResponse.json({ error: 'No output from merge script' }, { status: 500 });
    }
    const mergedUrl = buildEphemeralFileUrl(sessionId, `merged-glb/${jobId}/merged.glb`);
    return NextResponse.json({ success: true, mergedGlbUrl: mergedUrl, outputPath: result.output_path });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'merge-glb failed';
    const out = execFileStdout(error);
    const parsed = out ? parseLastJsonLine(out) : null;
    if (parsed?.error) {
      console.error('[merge-glb]', message, '| script:', parsed.error);
    } else {
      console.error('[merge-glb]', message);
    }
    return NextResponse.json(
      {
        error: parsed?.error || message,
        mergeScriptError: parsed?.error,
        rawScriptStdout: out?.trim().split('\n').slice(-12).join('\n'),
      },
      { status: 500 }
    );
  } finally {
    if (inputJsonPath) {
      try {
        await unlink(inputJsonPath);
      } catch {
        /* empty */
      }
    }
  }
}
