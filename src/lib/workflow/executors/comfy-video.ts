import { DEFAULT_COMFY_VIDEO_PRESET } from '@/lib/comfyui-video-preset';
import type { ComfyVideoRunSettings } from '@/lib/comfyui-workflow';
import type { WorkflowNodeExecutorContext } from '../types';

interface ComfyVideoResponse {
  success?: boolean;
  videoUrl?: unknown;
  videoName?: unknown;
  promptId?: unknown;
  detectedInputDir?: unknown;
  detectedOutputDir?: unknown;
  detectedInput3dDir?: unknown;
  error?: unknown;
}

function isBlobUrl(value: string): boolean {
  return value.startsWith('blob:');
}

function collectSettings(data: Record<string, unknown>): ComfyVideoRunSettings {
  return {
    comfyUrl: typeof data.comfyUrl === 'string' ? data.comfyUrl : DEFAULT_COMFY_VIDEO_PRESET.comfyUrl,
    comfyInput3dDir: typeof data.comfyInput3dDir === 'string' && data.comfyInput3dDir.trim()
      ? data.comfyInput3dDir.trim()
      : undefined,
    model: typeof data.model === 'string' ? data.model : DEFAULT_COMFY_VIDEO_PRESET.model,
    prompt: typeof data.prompt === 'string' ? data.prompt : DEFAULT_COMFY_VIDEO_PRESET.prompt,
    videoResolution: typeof data.videoResolution === 'string' ? data.videoResolution : DEFAULT_COMFY_VIDEO_PRESET.videoResolution,
    ratio: typeof data.ratio === 'string' ? data.ratio : DEFAULT_COMFY_VIDEO_PRESET.ratio,
    duration: typeof data.duration === 'number' ? data.duration : DEFAULT_COMFY_VIDEO_PRESET.duration,
    generateAudio: typeof data.generateAudio === 'boolean' ? data.generateAudio : DEFAULT_COMFY_VIDEO_PRESET.generateAudio,
    seed: typeof data.seed === 'number' ? data.seed : DEFAULT_COMFY_VIDEO_PRESET.seed,
    watermark: typeof data.watermark === 'boolean' ? data.watermark : DEFAULT_COMFY_VIDEO_PRESET.watermark,
    sceneSelection: typeof data.sceneSelection === 'string' ? data.sceneSelection : DEFAULT_COMFY_VIDEO_PRESET.sceneSelection,
    renderResolution: typeof data.renderResolution === 'number' ? data.renderResolution : DEFAULT_COMFY_VIDEO_PRESET.renderResolution,
    background: typeof data.background === 'string' ? data.background : DEFAULT_COMFY_VIDEO_PRESET.background,
    cameraElevation: typeof data.cameraElevation === 'number' ? data.cameraElevation : DEFAULT_COMFY_VIDEO_PRESET.cameraElevation,
    framePadding: typeof data.framePadding === 'number' ? data.framePadding : DEFAULT_COMFY_VIDEO_PRESET.framePadding,
    renderEngine: typeof data.renderEngine === 'string' ? data.renderEngine : DEFAULT_COMFY_VIDEO_PRESET.renderEngine,
    forceRender: typeof data.forceRender === 'boolean' ? data.forceRender : DEFAULT_COMFY_VIDEO_PRESET.forceRender,
    filenamePrefix: typeof data.filenamePrefix === 'string' ? data.filenamePrefix : DEFAULT_COMFY_VIDEO_PRESET.filenamePrefix,
    format: typeof data.format === 'string' ? data.format : DEFAULT_COMFY_VIDEO_PRESET.format,
    codec: typeof data.codec === 'string' ? data.codec : DEFAULT_COMFY_VIDEO_PRESET.codec,
  };
}

export async function executeComfyVideo(
  context: WorkflowNodeExecutorContext,
): Promise<Record<string, unknown>> {
  const modelUrl = context.node.data.modelUrl;
  if (typeof modelUrl !== 'string' || modelUrl.length === 0 || isBlobUrl(modelUrl)) {
    throw new Error('Model file unavailable, please wait for upload');
  }

  const settings = collectSettings(context.node.data as Record<string, unknown>);
  context.reportProgress({
    ...settings,
    comfyStatus: 'processing',
    progressText: 'Submitting to ComfyUI...',
    errorMessage: null,
    videoUrl: null,
    videoName: null,
    promptId: null,
  });

  const response = await context.apiFetch('/api/generate-comfy-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelUrl, settings }),
    signal: context.signal,
  });
  const result = (await response.json()) as ComfyVideoResponse;
  if (!result.success || typeof result.videoUrl !== 'string') {
    throw new Error(typeof result.error === 'string' ? result.error : 'ComfyUI video generation failed');
  }

  return {
    comfyStatus: 'done',
    progressText: 'ComfyUI video ready',
    videoUrl: result.videoUrl,
    videoName: typeof result.videoName === 'string' ? result.videoName : 'ComfyUI Video',
    promptId: typeof result.promptId === 'string' ? result.promptId : null,
    comfyOnline: true,
    detectedInputDir: typeof result.detectedInputDir === 'string' ? result.detectedInputDir : null,
    detectedOutputDir: typeof result.detectedOutputDir === 'string' ? result.detectedOutputDir : null,
    detectedInput3dDir: typeof result.detectedInput3dDir === 'string' ? result.detectedInput3dDir : null,
    errorMessage: null,
  };
}
