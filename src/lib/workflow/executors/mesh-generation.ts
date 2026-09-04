import { inferModelTypeFromUrl } from '@/lib/infer-model-type-from-url';
import type { WorkflowNodeExecutorContext } from '../types';

type MeshInputType = 'ply' | 'obj' | 'glb' | 'splat';
type MeshOutputType = 'glb' | 'obj' | 'ply';

interface MeshStartResponse {
  success?: boolean;
  taskId?: unknown;
  error?: unknown;
}

interface MeshStatusResponse {
  status?: unknown;
  result?: unknown;
  error?: unknown;
}

interface MeshResultPayload {
  meshUrl?: unknown;
  meshFormat?: unknown;
  faceCount?: unknown;
  layerGlbUrls?: unknown;
  layerNames?: unknown;
  segmentationProfile?: unknown;
  segmentationLabelCount?: unknown;
  segmentationMetadataUrl?: unknown;
}

function isBlobUrl(value: string): boolean {
  return value.startsWith('blob:');
}

function normalizeInputType(value: unknown, modelUrl: string): MeshInputType {
  if (value === 'ply' || value === 'obj' || value === 'glb' || value === 'splat') return value;
  const inferred = inferModelTypeFromUrl(modelUrl);
  return inferred === 'ply' || inferred === 'glb' ? inferred : 'obj';
}

function normalizeOutputFormat(value: unknown): MeshOutputType {
  return value === 'obj' || value === 'ply' ? value : 'glb';
}

function normalizeOutputType(value: unknown): MeshOutputType {
  return value === 'obj' || value === 'ply' ? value : 'glb';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('Mesh generation stopped');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new Error('Mesh generation stopped'));
      },
      { once: true },
    );
  });
}

function buildDonePatch(result: MeshResultPayload, inputType: MeshInputType): Record<string, unknown> {
  if (typeof result.meshUrl !== 'string') throw new Error('Mesh task returned no output URL');
  const resolvedType = normalizeOutputType(result.meshFormat);
  const nextInputType: MeshInputType =
    inputType === 'splat'
      ? 'splat'
      : resolvedType === 'ply'
        ? 'ply'
        : resolvedType === 'glb'
          ? 'glb'
          : 'obj';

  return {
    meshStatus: 'done',
    modelUrl: result.meshUrl,
    inputType: nextInputType,
    outputUrl: result.meshUrl,
    outputType: resolvedType,
    faceCount: typeof result.faceCount === 'number' ? result.faceCount : null,
    layerGlbUrls: stringArray(result.layerGlbUrls),
    layerNames: stringArray(result.layerNames),
    segmentationProfile: typeof result.segmentationProfile === 'string' ? result.segmentationProfile : undefined,
    segmentationLabelCount:
      typeof result.segmentationLabelCount === 'number' ? result.segmentationLabelCount : undefined,
    segmentationMetadataUrl:
      typeof result.segmentationMetadataUrl === 'string' ? result.segmentationMetadataUrl : undefined,
    errorMessage: null,
  };
}

export async function executeMeshGeneration(
  context: WorkflowNodeExecutorContext,
): Promise<Record<string, unknown>> {
  const modelUrl = context.node.data.modelUrl;
  if (typeof modelUrl !== 'string' || modelUrl.length === 0) throw new Error('Missing model input');
  if (isBlobUrl(modelUrl)) throw new Error('File is uploading, please wait...');

  const inputType = normalizeInputType(context.node.data.inputType, modelUrl);
  if (inputType === 'obj' || inputType === 'glb') {
    return {
      meshStatus: 'done',
      modelUrl,
      inputType,
      outputUrl: modelUrl,
      outputType: inputType,
      errorMessage: null,
    };
  }

  const requestedOutputFormat = inputType === 'splat' ? 'glb' : normalizeOutputFormat(context.node.data.outputFormat);
  const ephemeralSessionId = context.ephemeralSessionId ?? context.runId;

  context.reportProgress({ meshStatus: 'processing', errorMessage: null });
  const startResponse = await context.apiFetch('/api/generate-mesh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plyUrl: modelUrl, outputFormat: requestedOutputFormat, ephemeralSessionId }),
    signal: context.signal,
  });
  const started = (await startResponse.json()) as MeshStartResponse;
  if (!started.success || typeof started.taskId !== 'string') {
    throw new Error(typeof started.error === 'string' ? started.error : 'Failed to start mesh generation');
  }

  const maxRetries = 60;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    if (attempt === 0) {
      await sleep(1000, context.signal);
    }
    const statusResponse = await context.apiFetch(`/api/mesh-status?taskId=${encodeURIComponent(started.taskId)}`, {
      signal: context.signal,
    });
    const task = (await statusResponse.json()) as MeshStatusResponse;
    if (task.status === 'processing') {
      await sleep(2000, context.signal);
      continue;
    }
    if (task.status === 'done' && task.result) {
      return buildDonePatch(task.result as MeshResultPayload, inputType);
    }
    if (task.status === 'error') {
      throw new Error(typeof task.error === 'string' ? task.error : 'Mesh generation failed');
    }
    if (task.error && !task.status) {
      await sleep(2000, context.signal);
      continue;
    }
  }

  throw new Error('Task query timeout');
}
