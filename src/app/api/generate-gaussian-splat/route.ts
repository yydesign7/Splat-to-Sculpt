import { NextRequest, NextResponse } from 'next/server';
import { execFile, spawn } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import { promisify } from 'util';
import path from 'path';
import { randomUUID } from 'crypto';
import { getTask, setTask } from '@/lib/gaussian-task-store';
import { getTask as getPointCloudTask } from '@/lib/pointcloud-task-store';
import {
  buildEphemeralFileUrl,
  getSessionRoot,
  isValidEphemeralSessionId,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';
import { killProcessTree } from '@/lib/process-tree';

const execFileAsync = promisify(execFile);

type ComputeBackendKind = 'cuda' | 'mps' | 'cpu';
type GaussianTrainingMode = 'auto' | 'train';

type ComputeBackendInfo = {
  kind: ComputeBackendKind;
  label: string;
};

type TrainingSupportInfo = {
  trueTrainingAvailable: boolean;
  trueTrainingUnavailableReason?: string;
};

type PointCloudStageResult = {
  plyUrl: string;
  pointCount: number;
  layerFiles?: string[];
  layerNames?: string[];
  colmapWorkspacePath?: string;
  colmapImagesDir?: string;
  colmapSparseDir?: string;
  colmapDatabasePath?: string;
};

type GaussianPipelineInput = {
  plyUrl?: string;
  framePaths?: string[];
  trainingIterations: number;
  trainingMode: GaussianTrainingMode;
  ephemeralSessionId: string;
};

async function detectComputeBackend(pythonCommand: string): Promise<ComputeBackendInfo> {
  try {
    await execFileAsync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
    return { kind: 'cuda', label: 'CUDA GPU detected' };
  } catch {
    // Continue with Apple MPS detection.
  }

  try {
    const { stdout } = await execFileAsync(
      pythonCommand,
      [
        '-c',
        [
          'import torch',
          'ok = False',
          'try:',
          '    ok = bool(torch.backends.mps.is_available())',
          '    _ = torch.ones(1, device="mps") if ok else None',
          'except Exception:',
          '    ok = False',
          'print("mps" if ok else "cpu")',
        ].join('\n'),
      ],
      { timeout: 8000 },
    );
    if (stdout.trim() === 'mps') {
      return { kind: 'mps', label: 'Apple MPS detected' };
    }
  } catch {
    // PyTorch is optional for this Mac-friendly initializer.
  }

  return { kind: 'cpu', label: 'CPU fallback' };
}

function parseGaussianScriptJson(rawStdout: string): Record<string, unknown> | null {
  const lines = rawStdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const start = line.lastIndexOf('{');
    if (start < 0) continue;
    try {
      const value = JSON.parse(line.slice(start)) as Record<string, unknown>;
      if (value && typeof value.status === 'string') return value;
    } catch {
      // Keep looking.
    }
  }

  return null;
}

function resolveTrainerCommand(envName: string, fallback: string): string {
  return process.env[envName] || fallback;
}

function resolvePythonCommand(nsTrainCommand: string): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (nsTrainCommand.includes('/') || nsTrainCommand.includes('\\')) {
    return path.join(path.dirname(nsTrainCommand), 'python3');
  }
  return 'python3';
}

function normalizeTrainingIterations(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 1000;
  const snapped = Math.round(parsed / 1000) * 1000;
  return Math.min(10_000, Math.max(1000, snapped));
}

function normalizeTrainingMode(value: unknown): GaussianTrainingMode {
  return value === 'train' ? 'train' : 'auto';
}

function getTargetPlyType(backend: ComputeBackendInfo, trainingMode: GaussianTrainingMode): string {
  if (backend.kind === 'cuda' || trainingMode === 'train') {
    return 'Trained 3DGS-compatible gaussian_splat.ply';
  }
  return '3DGS-field initializer splat PLY';
}

async function detectTrueTrainingSupport(pythonCommand: string, backend: ComputeBackendInfo): Promise<TrainingSupportInfo> {
  if (backend.kind !== 'cuda') {
    return {
      trueTrainingAvailable: false,
      trueTrainingUnavailableReason: 'Nerfstudio Splatfacto requires the gsplat CUDA rasterizer in this setup.',
    };
  }

  try {
    const { stdout } = await execFileAsync(
      pythonCommand,
      [
        '-c',
        [
          'ok = False',
          'try:',
          '    from gsplat.cuda import _wrapper',
          '    ok = getattr(_wrapper, "_C", None) is not None',
          'except Exception:',
          '    ok = False',
          'print("ok" if ok else "missing")',
        ].join('\n'),
      ],
      {
        timeout: 8000,
        env: {
          ...process.env,
          MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/private/tmp/studio3dgs-matplotlib',
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/private/tmp/studio3dgs-cache',
        },
      },
    );
    if (stdout.trim() === 'ok') return { trueTrainingAvailable: true };
  } catch {
    // Fall through to a clear unavailable reason.
  }

  return {
    trueTrainingAvailable: false,
    trueTrainingUnavailableReason: 'The gsplat CUDA extension is not available in the current Python environment.',
  };
}

async function checkPythonRuntime(command: string): Promise<string | null> {
  try {
    await execFileAsync(command, ['-c', 'import numpy, nerfstudio, torch'], {
      timeout: 30_000,
      env: {
        ...process.env,
        MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/private/tmp/studio3dgs-matplotlib',
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/private/tmp/studio3dgs-cache',
      },
    });
    return null;
  } catch {
    return `Python runtime "${command}" cannot import numpy, nerfstudio, and torch. Set PYTHON_BIN to the Python executable in the Nerfstudio environment.`;
  }
}

async function checkTrainerCommand(command: string, kind: 'train' | 'export'): Promise<string | null> {
  const args = kind === 'train' ? ['splatfacto', '--help'] : ['gaussian-splat', '--help'];
  try {
    await execFileAsync(command, args, {
      timeout: 60_000,
      env: {
        ...process.env,
        MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/private/tmp/studio3dgs-matplotlib',
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/private/tmp/studio3dgs-cache',
      },
    });
    return null;
  } catch {
    const envName = kind === 'train' ? 'NS_TRAIN_BIN' : 'NS_EXPORT_BIN';
    return `3DGS ${kind === 'train' ? 'trainer' : 'exporter'} command "${command}" is not available. Set ${envName} to a valid Nerfstudio executable.`;
  }
}

function runGaussianScript(
  pythonCommand: string,
  args: string[],
  options: {
    timeout: number;
    onJson?: (value: Record<string, unknown>) => void;
    onStart?: (pid: number) => void;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonCommand,
      args,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/private/tmp/studio3dgs-matplotlib',
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/private/tmp/studio3dgs-cache',
        },
        detached: process.platform !== 'win32',
      },
    );
    if (typeof child.pid === 'number') {
      options.onStart?.(child.pid);
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      if (typeof child.pid === 'number') {
        killProcessTree(child.pid).catch(() => {});
      } else {
        child.kill('SIGTERM');
      }
      const err = new Error('Gaussian splat training timed out') as Error & { stdout?: string; stderr?: string };
      err.stdout = stdout;
      err.stderr = stderr;
      settled = true;
      reject(err);
    }, options.timeout);

    const handleStdout = (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('{')) continue;
        try {
          options.onJson?.(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Ignore non-JSON progress text.
        }
      }
    };

    child.stdout.on('data', handleStdout);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      clearTimeout(timer);
      const enriched = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      enriched.stdout = stdout;
      enriched.stderr = stderr;
      settled = true;
      reject(enriched);
    });
    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`Gaussian splat training exited with code ${code}`) as Error & { stdout?: string; stderr?: string };
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { plyUrl, framePaths, trainingIterations: requestedTrainingIterations, ephemeralSessionId } = body as {
    plyUrl?: string;
    framePaths?: string[];
    trainingIterations?: number;
    trainingMode?: GaussianTrainingMode;
    ephemeralSessionId?: string;
  };
  const trainingIterations = normalizeTrainingIterations(requestedTrainingIterations);
  const requestedTrainingMode = normalizeTrainingMode(body.trainingMode);

  const hasFrames = Array.isArray(framePaths) && framePaths.length > 0;
  const hasPly = typeof plyUrl === 'string' && plyUrl.length > 0;
  if (!hasFrames && !hasPly) {
    return NextResponse.json({ error: 'No frame images or point cloud file path provided' }, { status: 400 });
  }
  if (!hasFrames) {
    return NextResponse.json(
      { error: 'True 3DGS training requires extracted frames and COLMAP camera poses. PLY-only input cannot be trained as a real Gaussian splat.' },
      { status: 400 },
    );
  }
  if (!isValidEphemeralSessionId(ephemeralSessionId)) {
    return NextResponse.json({ error: 'Missing or invalid ephemeralSessionId' }, { status: 400 });
  }

  const nsTrainCommand = resolveTrainerCommand('NS_TRAIN_BIN', 'ns-train');
  const nsExportCommand = resolveTrainerCommand('NS_EXPORT_BIN', 'ns-export');
  const pythonCommand = resolvePythonCommand(nsTrainCommand);
  const pythonError = await checkPythonRuntime(pythonCommand);
  if (pythonError) {
    return NextResponse.json({ error: pythonError }, { status: 503 });
  }
  const trainError = await checkTrainerCommand(nsTrainCommand, 'train');
  if (trainError) {
    return NextResponse.json({ error: trainError }, { status: 503 });
  }
  const exportError = await checkTrainerCommand(nsExportCommand, 'export');
  if (exportError) {
    return NextResponse.json({ error: exportError }, { status: 503 });
  }

  const taskId = randomUUID();
  const backend = await detectComputeBackend(pythonCommand);
  const trainingSupport = await detectTrueTrainingSupport(pythonCommand, backend);
  const trainingMode: GaussianTrainingMode =
    requestedTrainingMode === 'train' && trainingSupport.trueTrainingAvailable ? 'train' : 'auto';
  const targetPlyType = getTargetPlyType(backend, trainingMode);
  const computeBackend = requestedTrainingMode === 'train' && trainingMode === 'auto'
    ? `${backend.label}; true training unavailable, using initializer`
    : backend.label;
  await setTask(taskId, {
    status: 'processing',
    progress: hasFrames ? 'Initializing reconstruction for Gaussian splat...' : 'Initializing Gaussian splat generation...',
    progressStep: 0,
    deviceType: backend.kind,
    computeBackend,
    trainingMode,
    targetPlyType,
    trueTrainingAvailable: trainingSupport.trueTrainingAvailable,
    trueTrainingUnavailableReason: trainingSupport.trueTrainingUnavailableReason,
    ephemeralSessionId,
  });

  runGaussianPipeline(
    taskId,
    { plyUrl, framePaths, trainingIterations, trainingMode, ephemeralSessionId },
    request.nextUrl.origin,
    backend,
    { nsTrainCommand, nsExportCommand, pythonCommand },
  ).catch(() => {});

  return NextResponse.json({
    success: true,
    taskId,
    deviceType: backend.kind,
    computeBackend,
    trainingMode,
    targetPlyType,
    trueTrainingAvailable: trainingSupport.trueTrainingAvailable,
    trueTrainingUnavailableReason: trainingSupport.trueTrainingUnavailableReason,
    message: 'Gaussian splat generation task started',
  });
}

async function waitForPointCloudStage(taskId: string, pointcloudTaskId: string): Promise<PointCloudStageResult> {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const gaussianTask = await getTask(taskId);
    if (gaussianTask?.status === 'cancelled') {
      throw new Error('Gaussian splat generation was cancelled');
    }

    const task = await getPointCloudTask(pointcloudTaskId);
    if (!task) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (task.status === 'processing') {
      const pointcloudStep = typeof task.progressStep === 'number' ? task.progressStep : undefined;
      await setTask(taskId, {
        progress: task.progress ? `COLMAP camera solve: ${task.progress}` : 'Solving COLMAP camera poses...',
        progressStep: pointcloudStep != null ? Math.min(4, Math.max(1, pointcloudStep)) : undefined,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    if (task.status === 'done' && task.result) {
      return task.result;
    }

    if (task.status === 'error') {
      throw new Error(task.error || 'Source geometry reconstruction failed');
    }
    if (task.status === 'cancelled') {
      throw new Error('Source geometry reconstruction was cancelled');
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error('Source geometry reconstruction timeout');
}

async function runPointCloudStage(
  taskId: string,
  origin: string,
  input: GaussianPipelineInput,
): Promise<PointCloudStageResult> {
  await setTask(taskId, {
    progress: 'Starting source geometry reconstruction...',
    progressStep: 1,
  });

  const response = await fetch(`${origin}/api/generate-pointcloud`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      framePaths: input.framePaths,
      enableDepthFusion: false,
      enableSegmentation: false,
      ephemeralSessionId: input.ephemeralSessionId,
      preserveColmapWorkspace: true,
      colmapOnly: true,
    }),
  });
  const started = await response.json();
  if (!response.ok || !started.success || typeof started.taskId !== 'string') {
    throw new Error(started.error || 'Failed to start source geometry reconstruction');
  }

  await setTask(taskId, { pointcloudTaskId: started.taskId });
  return waitForPointCloudStage(taskId, started.taskId);
}

async function ensureNotCancelled(taskId: string) {
  const task = await getTask(taskId);
  if (task?.status === 'cancelled') {
    throw new Error('Gaussian splat generation was cancelled');
  }
}

async function runGaussianPipeline(
  taskId: string,
  input: GaussianPipelineInput,
  origin: string,
  backend: ComputeBackendInfo,
  trainer: { nsTrainCommand: string; nsExportCommand: string; pythonCommand: string },
) {
  let colmapWorkspacePath: string | undefined;
  try {
    const targetPlyType = getTargetPlyType(backend, input.trainingMode);
    await setTask(taskId, {
      progress: 'Preparing Gaussian splat input...',
      deviceType: backend.kind,
      computeBackend: backend.label,
      trainingMode: input.trainingMode,
      targetPlyType,
    });

    let sourcePlyUrl = input.plyUrl || '';
    let layerFiles: string[] = [];
    let layerNames: string[] = [];

    if (!sourcePlyUrl && input.framePaths && input.framePaths.length > 0) {
      await ensureNotCancelled(taskId);
      const pointCloud = await runPointCloudStage(taskId, origin, input);
      await ensureNotCancelled(taskId);
      sourcePlyUrl = pointCloud.plyUrl;
      layerFiles = pointCloud.layerFiles || [];
      layerNames = pointCloud.layerNames || [];
      colmapWorkspacePath = pointCloud.colmapWorkspacePath;

      if (!pointCloud.colmapImagesDir || !pointCloud.colmapSparseDir) {
        throw new Error('COLMAP reconstruction completed, but camera/image paths were not returned for 3DGS training');
      }

      const jobId = randomUUID();
      const jobRoot = path.join(getSessionRoot(input.ephemeralSessionId), 'gaussian-splats', jobId);
      const shouldTrainWithNerfstudio = backend.kind === 'cuda' || input.trainingMode === 'train';
      const outputDir = shouldTrainWithNerfstudio ? jobRoot : path.join(jobRoot, 'export');
      await mkdir(outputDir, { recursive: true });

      if (!shouldTrainWithNerfstudio) {
        await setTask(taskId, {
          progress: 'Generating Gaussian splat initializer from COLMAP point cloud...',
          progressStep: 6,
          deviceType: backend.kind,
          computeBackend: `${backend.label}; COLMAP splat initializer fallback`,
          trainingMode: input.trainingMode,
          targetPlyType,
          currentTrainingIteration: undefined,
          maxTrainingIterations: undefined,
        });

        const scriptPath = path.join(process.cwd(), 'scripts', 'generate_gaussian_splat.py');
        const sourcePlyPath = resolveClientMediaUrlToFilesystem(sourcePlyUrl);
        const { stdout, stderr } = await runGaussianScript(
          trainer.pythonCommand,
          [
            scriptPath,
            '--input',
            sourcePlyPath,
            '--output-dir',
            outputDir,
            '--device',
            'cpu',
          ],
          {
            timeout: 600_000,
            onStart: (pid) => {
              setTask(taskId, { trainingPid: pid }).catch(() => {});
            },
          },
        );

        await setTask(taskId, { trainingPid: undefined });
        if (stderr?.trim()) {
          console.error('[generate-gaussian-splat-fallback] python stderr (tail):\n', stderr.slice(-4000));
        }

        const result = parseGaussianScriptJson(stdout);
        if (!result || result.status === 'error') {
          await setTask(taskId, {
            status: 'error',
            error: String(result?.error || `No valid JSON result in Gaussian initializer output. stdout tail: ${stdout.slice(-1000)}`),
          });
          return;
        }

        const outPath = result.outputPath;
        if (typeof outPath !== 'string' || !outPath) {
          await setTask(taskId, { status: 'error', error: 'Gaussian initializer returned no outputPath' });
          return;
        }

        const outputFileName = path.basename(outPath);
        const splatUrl = buildEphemeralFileUrl(input.ephemeralSessionId, `gaussian-splats/${jobId}/export/${outputFileName}`);
        const computeBackend = `${backend.label}; COLMAP splat initializer fallback`;

        await setTask(taskId, {
          status: 'done',
          progress: 'Done',
          progressStep: 8,
          deviceType: backend.kind,
          computeBackend,
          trainingMode: input.trainingMode,
          targetPlyType,
          result: {
            splatUrl,
            sourcePlyUrl,
            gaussianCount: Number(result.gaussianCount) || 0,
            format: '3dgs-ply',
            layerFiles,
            layerNames,
            computeBackend,
          },
        });
        return;
      }

      await setTask(taskId, {
        progress: `Preparing Nerfstudio training data (${backend.label})...`,
        progressStep: 5,
        deviceType: backend.kind,
        computeBackend: backend.label,
        trainingMode: input.trainingMode,
        targetPlyType,
        currentTrainingIteration: 0,
        maxTrainingIterations: input.trainingIterations,
      });

      const scriptPath = path.join(process.cwd(), 'scripts', 'train_gaussian_splat.py');
      const maxIterations = input.trainingIterations;
      const { stdout, stderr } = await runGaussianScript(
        trainer.pythonCommand,
        [
          scriptPath,
          '--images-dir',
          pointCloud.colmapImagesDir,
          '--sparse-dir',
          pointCloud.colmapSparseDir,
          '--output-dir',
          outputDir,
          '--max-iterations',
          String(maxIterations),
          '--device',
          backend.kind,
          '--ns-train',
          trainer.nsTrainCommand,
          '--ns-export',
          trainer.nsExportCommand,
        ],
        {
          timeout: 7_200_000,
          onJson: (value) => {
            if (value.status === 'progress') {
              setTask(taskId, {
                progress: typeof value.progress === 'string' ? value.progress : 'Training Gaussian splat...',
                progressStep: typeof value.progressStep === 'number' ? value.progressStep : undefined,
                deviceType: backend.kind,
                trainingMode: input.trainingMode,
                targetPlyType,
                currentTrainingIteration:
                  typeof value.currentTrainingIteration === 'number' ? value.currentTrainingIteration : undefined,
                maxTrainingIterations:
                  typeof value.maxTrainingIterations === 'number' ? value.maxTrainingIterations : undefined,
              }).catch(() => {});
            }
          },
          onStart: (pid) => {
            setTask(taskId, { trainingPid: pid }).catch(() => {});
          },
        },
      );

      await setTask(taskId, { trainingPid: undefined });

      if (stderr?.trim()) {
        console.error('[train-gaussian-splat] python stderr (tail):\n', stderr.slice(-4000));
      }

      const result = parseGaussianScriptJson(stdout);
      if (!result) {
        await setTask(taskId, {
          status: 'error',
          error: `No valid JSON result in Gaussian training output. stdout tail: ${stdout.slice(-1000)}`,
        });
        return;
      }

      if (result.status === 'error') {
        await setTask(taskId, {
          status: 'error',
          error: String(result.error || 'Gaussian splat training failed'),
        });
        return;
      }

      const outPath = result.outputPath;
      if (typeof outPath !== 'string' || !outPath) {
        await setTask(taskId, { status: 'error', error: 'Gaussian trainer returned no outputPath' });
        return;
      }

      const outputFileName = path.basename(outPath);
      const splatUrl = buildEphemeralFileUrl(input.ephemeralSessionId, `gaussian-splats/${jobId}/export/${outputFileName}`);
      const scriptBackend = typeof result.trainer === 'string' ? result.trainer : 'nerfstudio-splatfacto';

      await setTask(taskId, {
        status: 'done',
        progress: 'Done',
        progressStep: 8,
        deviceType: backend.kind,
        computeBackend: `${scriptBackend} (${backend.label})`,
        trainingMode: input.trainingMode,
        targetPlyType,
        result: {
          splatUrl,
          sourcePlyUrl,
          gaussianCount: Number(result.gaussianCount) || 0,
          format: '3dgs-ply',
          layerFiles,
          layerNames,
          computeBackend: `${scriptBackend} (${backend.label})`,
        },
      });
      return;
    }

    throw new Error('True 3DGS training requires extracted frames and COLMAP camera poses; PLY-only initialization has been disabled.');
  } catch (error: unknown) {
    const currentTask = await getTask(taskId);
    if (currentTask?.status === 'cancelled') {
      return;
    }
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const stdout = err.stdout?.toString() ?? '';
    const parsed = stdout ? parseGaussianScriptJson(stdout) : null;
    const parsedError = parsed?.status === 'error' ? String(parsed.error || '') : '';
    const message = parsedError || (error instanceof Error ? error.message : 'Gaussian splat generation failed');
    if (stdout.trim() || err.stderr?.trim()) {
      console.error(
        '[generate-gaussian-splat] Process failed; stdout tail:',
        stdout.slice(-2000),
        'stderr tail:',
        (err.stderr || '').slice(-2000),
      );
    }
    await setTask(taskId, { status: 'error', error: message, trainingPid: undefined });
  } finally {
    if (colmapWorkspacePath) {
      await rm(colmapWorkspacePath, { recursive: true, force: true }).catch(() => {});
    }
  }
}
