import { inferModelTypeFromUrl } from '@/lib/infer-model-type-from-url';
import type { WorkflowNodeExecutorContext } from '../types';

interface BlenderMaterialResponse {
  success?: boolean;
  glbUrl?: unknown;
  modelUrl?: unknown;
  renderUrl?: unknown;
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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isBlobUrl(value: string): boolean {
  return value.startsWith('blob:');
}

export async function executeSurfaceProcessing(
  context: WorkflowNodeExecutorContext,
): Promise<Record<string, unknown>> {
  const modelUrl = typeof context.node.data.modelUrl === 'string' ? context.node.data.modelUrl : null;
  const layerGlbUrls = stringArray(context.node.data.layerGlbUrls);
  const layerNames = stringArray(context.node.data.layerNames);
  const lightParams = context.node.data.lightParams ?? null;
  const layerParams = recordValue(context.node.data.layerParams);

  context.reportProgress({ blenderProcessing: true, blenderError: null });

  if (layerGlbUrls.length > 0) {
    for (const url of layerGlbUrls) {
      if (isBlobUrl(url)) throw new Error('Cannot merge blob URLs on server; wait for uploads to finish');
    }
    const names = layerNames.length === layerGlbUrls.length
      ? layerNames
      : layerGlbUrls.map((_, index) => `layer_${index}`);
    const response = await context.apiFetch('/api/merge-glb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ glbPaths: layerGlbUrls, names }),
      signal: context.signal,
    });
    const result = (await response.json()) as MergeResponse;
    if (!response.ok || !result.success || typeof result.mergedGlbUrl !== 'string') {
      throw new Error(typeof result.error === 'string' ? result.error : 'Server merge failed');
    }
    return {
      blenderProcessing: false,
      blenderError: null,
      outputModelUrl: result.mergedGlbUrl,
      outputModelType: 'glb',
      layerNames: names,
      layerGlbUrls,
      layerParams,
      lightParams,
    };
  }

  if (!modelUrl) throw new Error('Missing model input');
  if (isBlobUrl(modelUrl)) throw new Error('File is uploading, please wait before trying again');

  const materialParams = recordValue(context.node.data.materialParams);
  const response = await context.apiFetch('/api/blender-material', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'apply',
      modelUrl,
      textureUrl: context.node.data.materialPreviewUrl || undefined,
      lightParams,
      render: true,
      group: typeof context.node.data.selectedLayer === 'string' ? context.node.data.selectedLayer : 'all',
      materialParams,
      baseColorModified: materialParams.base_color_modified === true,
    }),
    signal: context.signal,
  });
  const result = (await response.json()) as BlenderMaterialResponse;
  if (!result.success) {
    throw new Error(typeof result.error === 'string' ? result.error : 'Blender processing failed');
  }
  const outputModelUrl = typeof result.glbUrl === 'string' ? result.glbUrl : result.modelUrl;
  if (typeof outputModelUrl !== 'string' || outputModelUrl.length === 0) {
    throw new Error('Blender returned no output model');
  }
  const outputModelType = typeof result.glbUrl === 'string'
    ? 'glb'
    : inferModelTypeFromUrl(outputModelUrl) || 'obj';

  return {
    blenderProcessing: false,
    blenderError: null,
    outputModelUrl,
    outputModelType,
    renderUrl: typeof result.renderUrl === 'string' ? result.renderUrl : null,
    layerParams,
    lightParams,
  };
}
