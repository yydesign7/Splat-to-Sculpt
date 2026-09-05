import { inferModelTypeFromUrl } from '@/lib/infer-model-type-from-url';
import { selectModelCleanupMode } from '@/lib/model-cleanup-mode';
import type { WorkflowNodeExecutorContext } from '../types';

type ModelOutputType = 'glb' | 'fbx' | 'obj' | 'ply';

interface CleanupResponse {
  success?: boolean;
  glbUrl?: unknown;
  modelUrl?: unknown;
  error?: unknown;
}

interface MergeResponse {
  success?: boolean;
  mergedGlbUrl?: unknown;
  error?: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function outputTypeFromUrl(url: string): ModelOutputType {
  const inferred = inferModelTypeFromUrl(url);
  return inferred === 'glb' || inferred === 'fbx' || inferred === 'ply' ? inferred : 'obj';
}

function assertServerUrl(url: string, message: string): void {
  if (url.startsWith('blob:')) throw new Error(message);
}

async function runSingleCleanup(context: WorkflowNodeExecutorContext, modelUrl: string): Promise<string> {
  const response = await context.apiFetch('/api/blender-organize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelUrl }),
    signal: context.signal,
  });
  const result = (await response.json()) as CleanupResponse;
  if (!result.success) {
    throw new Error(typeof result.error === 'string' ? result.error : 'Model cleanup failed');
  }
  const outputUrl = typeof result.glbUrl === 'string' ? result.glbUrl : result.modelUrl;
  if (typeof outputUrl !== 'string' || outputUrl.length === 0) {
    throw new Error('No output URL from cleanup');
  }
  return outputUrl;
}

export async function executeModelCleanup(
  context: WorkflowNodeExecutorContext,
): Promise<Record<string, unknown>> {
  const modelUrl = typeof context.node.data.modelUrl === 'string' ? context.node.data.modelUrl : null;
  const layerGlbUrls = stringArray(context.node.data.layerGlbUrls);
  const layerNames = stringArray(context.node.data.layerNames);
  const cleanupMode = selectModelCleanupMode({
    modelUrl,
    layerGlbUrls: layerGlbUrls.length > 0 ? layerGlbUrls : null,
  });

  if (cleanupMode === 'none') throw new Error('File is uploading, please wait...');
  context.reportProgress({ organizeStatus: 'organizing', errorMessage: null });

  if (cleanupMode === 'layers') {
    for (const url of layerGlbUrls) assertServerUrl(url, 'A layer file is still uploading, please wait...');
    const cleanedLayerUrls: string[] = [];
    for (const url of layerGlbUrls) {
      cleanedLayerUrls.push(await runSingleCleanup(context, url));
    }
    const names = layerNames.length === cleanedLayerUrls.length
      ? layerNames
      : cleanedLayerUrls.map((_, index) => `layer_${index}`);
    const mergeResponse = await context.apiFetch('/api/merge-glb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ glbPaths: cleanedLayerUrls, names }),
      signal: context.signal,
    });
    const merged = (await mergeResponse.json()) as MergeResponse;
    if (!mergeResponse.ok || !merged.success || typeof merged.mergedGlbUrl !== 'string') {
      throw new Error(typeof merged.error === 'string' ? merged.error : 'Failed to merge after cleanup');
    }
    return {
      organizeStatus: 'done',
      outputUrl: merged.mergedGlbUrl,
      outputType: 'glb',
      layerNames: names,
      layerGlbUrls: cleanedLayerUrls,
      errorMessage: null,
    };
  }

  if (!modelUrl) throw new Error('Missing model input');
  assertServerUrl(modelUrl, 'File is uploading, please wait...');
  const outputUrl = await runSingleCleanup(context, modelUrl);
  const outputType = outputUrl.endsWith('.glb') ? 'glb' : outputTypeFromUrl(outputUrl);
  return {
    organizeStatus: 'done',
    outputUrl,
    outputType,
    layerNames,
    layerGlbUrls,
    errorMessage: null,
  };
}
