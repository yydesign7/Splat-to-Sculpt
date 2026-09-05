import type { WorkflowExecutionMode, WorkflowNodeExecutorContext } from '../types';

interface RotationVideoResponse {
  success?: boolean;
  videoUrl?: unknown;
  error?: unknown;
}

export function getVideoPreviewExecutionMode(data: Record<string, unknown>): WorkflowExecutionMode {
  return typeof data.videoUrl === 'string' && data.videoUrl.length > 0 ? 'passive-sink' : 'automatic';
}

function isBlobUrl(value: string): boolean {
  return value.startsWith('blob:');
}

export async function executeVideoPreview(
  context: WorkflowNodeExecutorContext,
): Promise<Record<string, unknown>> {
  if (typeof context.node.data.videoUrl === 'string' && context.node.data.videoUrl.length > 0) {
    return {
      videoUrl: context.node.data.videoUrl,
      videoName: typeof context.node.data.videoName === 'string' ? context.node.data.videoName : null,
      videoGenerating: false,
      errorMessage: null,
    };
  }

  const modelUrl = context.node.data.modelUrl;
  if (typeof modelUrl !== 'string' || modelUrl.length === 0 || isBlobUrl(modelUrl)) {
    throw new Error('Model file unavailable, please wait for upload');
  }

  context.reportProgress({ videoGenerating: true, errorMessage: null });
  const response = await context.apiFetch('/api/generate-rotation-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelUrl, lightParams: context.node.data.lightParams ?? null }),
    signal: context.signal,
  });
  const result = (await response.json()) as RotationVideoResponse;
  if (!result.success || typeof result.videoUrl !== 'string') {
    throw new Error(typeof result.error === 'string' ? result.error : 'Video generation failed');
  }
  return {
    videoGenerating: false,
    videoUrl: result.videoUrl,
    videoName: 'Rotation Preview',
    errorMessage: null,
  };
}
