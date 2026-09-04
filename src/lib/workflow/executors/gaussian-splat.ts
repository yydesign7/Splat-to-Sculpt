import {
  GAUSSIAN_TASK_MAX_POLL_ATTEMPTS,
  GAUSSIAN_TASK_POLL_INTERVAL_MS,
} from '@/lib/gaussian-task-polling';
import type { WorkflowNodeExecutorContext } from '../types';

type GaussianDeviceType = 'cuda' | 'mps' | 'cpu';
type GaussianTrainingMode = 'auto' | 'train';

interface GaussianStartResponse {
  success?: boolean;
  taskId?: unknown;
  deviceType?: unknown;
  computeBackend?: unknown;
  trainingMode?: unknown;
  targetPlyType?: unknown;
  trueTrainingAvailable?: unknown;
  trueTrainingUnavailableReason?: unknown;
  error?: unknown;
}

interface GaussianStatusResponse {
  status?: unknown;
  progress?: unknown;
  progressStep?: unknown;
  deviceType?: unknown;
  computeBackend?: unknown;
  trainingMode?: unknown;
  targetPlyType?: unknown;
  trueTrainingAvailable?: unknown;
  trueTrainingUnavailableReason?: unknown;
  currentTrainingIteration?: unknown;
  maxTrainingIterations?: unknown;
  result?: unknown;
  error?: unknown;
}

interface GaussianResult {
  splatUrl: string;
  sourcePlyUrl: string;
  gaussianCount: number;
  format: '3dgs-ply';
}

function normalizeGaussianDeviceType(value: unknown): GaussianDeviceType | null {
  return value === 'cuda' || value === 'mps' || value === 'cpu' ? value : null;
}

function normalizeGaussianTrainingMode(value: unknown): GaussianTrainingMode {
  return value === 'train' ? 'train' : 'auto';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('Gaussian splat generation stopped');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new Error('Gaussian splat generation stopped'));
      },
      { once: true },
    );
  });
}

function parseGaussianResult(value: unknown): GaussianResult {
  const result = value as Partial<Record<keyof GaussianResult, unknown>>;
  if (
    typeof result.splatUrl !== 'string' ||
    typeof result.sourcePlyUrl !== 'string' ||
    typeof result.gaussianCount !== 'number'
  ) {
    throw new Error('Gaussian splat task returned an invalid result');
  }
  return {
    splatUrl: result.splatUrl,
    sourcePlyUrl: result.sourcePlyUrl,
    gaussianCount: result.gaussianCount,
    format: '3dgs-ply',
  };
}

async function waitForGaussianTask(
  taskId: string,
  context: WorkflowNodeExecutorContext,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < GAUSSIAN_TASK_MAX_POLL_ATTEMPTS; attempt += 1) {
    if (context.signal.aborted) throw new Error('Gaussian splat generation stopped');
    const response = await context.apiFetch(`/api/gaussian-status?taskId=${encodeURIComponent(taskId)}`, {
      signal: context.signal,
    });
    const task = (await response.json()) as GaussianStatusResponse;

    if (task.status === 'processing') {
      context.reportProgress({
        status: 'processing',
        progressText: stringOrNull(task.progress) ?? 'Generating splats...',
        progressStep: numberOrNull(task.progressStep),
        deviceType: normalizeGaussianDeviceType(task.deviceType),
        computeBackend: stringOrNull(task.computeBackend),
        trainingMode: normalizeGaussianTrainingMode(task.trainingMode),
        targetPlyType: stringOrNull(task.targetPlyType),
        trueTrainingAvailable:
          typeof task.trueTrainingAvailable === 'boolean' ? task.trueTrainingAvailable : undefined,
        trueTrainingUnavailableReason: stringOrNull(task.trueTrainingUnavailableReason),
        currentTrainingIteration: numberOrNull(task.currentTrainingIteration),
        maxTrainingIterations: numberOrNull(task.maxTrainingIterations),
      });
      await sleep(GAUSSIAN_TASK_POLL_INTERVAL_MS, context.signal);
      continue;
    }

    if (task.status === 'done') {
      const result = parseGaussianResult(task.result);
      return {
        sourcePlyUrl: result.sourcePlyUrl,
        splatUrl: result.splatUrl,
        gaussianCount: result.gaussianCount,
        deviceType: normalizeGaussianDeviceType(task.deviceType),
        computeBackend: stringOrNull(task.computeBackend),
        trainingMode: normalizeGaussianTrainingMode(task.trainingMode),
        targetPlyType: stringOrNull(task.targetPlyType),
        status: 'done',
        progressText: null,
        progressStep: null,
        currentTrainingIteration: null,
        maxTrainingIterations: null,
        activeTaskId: null,
        errorMessage: null,
      };
    }

    if (task.status === 'cancelled') throw new Error('Gaussian splat generation stopped');
    if (task.status === 'error') {
      throw new Error(typeof task.error === 'string' ? task.error : 'Gaussian splat generation failed');
    }

    await sleep(GAUSSIAN_TASK_POLL_INTERVAL_MS, context.signal);
  }

  throw new Error('Gaussian splat task timeout');
}

export async function executeGaussianSplat(
  context: WorkflowNodeExecutorContext,
): Promise<Record<string, unknown>> {
  const framePaths = Array.isArray(context.node.data.framePaths) ? context.node.data.framePaths : [];
  const sourcePlyUrl = stringOrNull(context.node.data.sourcePlyUrl);
  const hasFrames = framePaths.length > 0;
  if (!hasFrames && !sourcePlyUrl) throw new Error('Missing frames or point cloud input');

  const trainingMode = hasFrames ? normalizeGaussianTrainingMode(context.node.data.trainingMode) : 'auto';
  const trainingIterations =
    typeof context.node.data.trainingIterations === 'number' ? context.node.data.trainingIterations : 1000;
  const ephemeralSessionId = context.ephemeralSessionId ?? context.runId;

  context.reportProgress({
    status: 'processing',
    progressText: hasFrames
      ? 'Starting reconstruction for Gaussian splat...'
      : 'Starting Gaussian splat generation...',
    progressStep: 0,
    errorMessage: null,
    trainingMode,
    currentTrainingIteration: null,
    maxTrainingIterations: trainingIterations,
    activeTaskId: null,
  });

  const startResponse = await context.apiFetch('/api/generate-gaussian-splat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      framePaths: hasFrames ? framePaths : undefined,
      plyUrl: hasFrames ? undefined : sourcePlyUrl,
      trainingIterations,
      trainingMode,
      ephemeralSessionId,
    }),
    signal: context.signal,
  });
  const started = (await startResponse.json()) as GaussianStartResponse;
  if (!started.success || typeof started.taskId !== 'string') {
    throw new Error(typeof started.error === 'string' ? started.error : 'Failed to start Gaussian splat generation');
  }

  context.reportProgress({
    activeTaskId: started.taskId,
    deviceType: normalizeGaussianDeviceType(started.deviceType),
    computeBackend: stringOrNull(started.computeBackend),
    trainingMode: normalizeGaussianTrainingMode(started.trainingMode),
    targetPlyType: stringOrNull(started.targetPlyType),
    trueTrainingAvailable:
      typeof started.trueTrainingAvailable === 'boolean' ? started.trueTrainingAvailable : undefined,
    trueTrainingUnavailableReason: stringOrNull(started.trueTrainingUnavailableReason),
  });

  return waitForGaussianTask(started.taskId, context);
}
