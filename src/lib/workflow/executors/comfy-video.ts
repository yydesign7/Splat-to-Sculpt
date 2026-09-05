import { DEFAULT_COMFY_VIDEO_PRESET } from '@/lib/comfyui-video-preset';
import { readComfyProbe } from '@/lib/comfyui-service-state';
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
  const stopDisplay = (): void => {
    context.reportProgress({ comfyStatus: 'idle', progressText: null });
  };
  context.signal.throwIfAborted();
  context.signal.addEventListener('abort', stopDisplay, { once: true });
  try {
    const modelUrl = context.node.data.modelUrl;
    if (typeof modelUrl !== 'string' || modelUrl.length === 0 || isBlobUrl(modelUrl)) {
      throw new Error('Model file unavailable, please wait for upload');
    }
    const settings = collectSettings(context.node.data);
    context.reportProgress({ comfyStatus: 'processing', progressText: 'Checking ComfyUI requirements…', errorMessage: null });
    const params = new URLSearchParams({ comfyUrl: settings.comfyUrl || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl });
    const statusResponse = await context.apiFetch(`/api/comfy-video-status?${params}`, {
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(7000)]),
    });
    const probe = readComfyProbe(await statusResponse.json());
    context.signal.throwIfAborted();
    if (probe.kind !== 'connected') {
      throw new Error(probe.kind === 'unreachable'
        ? 'ComfyUI 未连接。请启动服务并检查连接后重试。'
        : probe.kind === 'invalid-url' ? 'ComfyUI 地址无效。请设置有效的本机 HTTP(S) 地址后重试。'
          : 'ComfyUI 连接检查失败，请检查服务并重试。');
    }
    const seedanceResponse = await context.apiFetch(`/api/comfy-seedance-status?${params}`, {
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(7000)]),
    });
    const seedance = await seedanceResponse.json() as { success?: boolean; ready?: boolean };
    context.signal.throwIfAborted();
    if (!seedanceResponse.ok || seedance.success !== true) throw new Error('Seedance 检查失败，请检查 ComfyUI 后重试。');
    if (seedance.ready !== true) throw new Error('Seedance 尚未就绪。请安装所需插件或重启 ComfyUI 后重试。');

    context.reportProgress({
      ...settings, comfyStatus: 'processing', progressText: 'Submitting to ComfyUI...',
      errorMessage: null, videoUrl: null, videoName: null, promptId: null,
    });
    const response = await context.apiFetch('/api/generate-comfy-video', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelUrl, settings }), signal: context.signal,
    });
    const result = await response.json() as ComfyVideoResponse;
    context.signal.throwIfAborted();
    if (!response.ok || !result.success || typeof result.videoUrl !== 'string') {
      throw new Error(typeof result.error === 'string' ? result.error : 'ComfyUI video generation failed');
    }
    return {
      comfyStatus: 'done', progressText: 'ComfyUI video ready', videoUrl: result.videoUrl,
      videoName: typeof result.videoName === 'string' ? result.videoName : 'ComfyUI Video',
      promptId: typeof result.promptId === 'string' ? result.promptId : null,
      detectedInputDir: typeof result.detectedInputDir === 'string' ? result.detectedInputDir : null,
      detectedOutputDir: typeof result.detectedOutputDir === 'string' ? result.detectedOutputDir : null,
      detectedInput3dDir: typeof result.detectedInput3dDir === 'string' ? result.detectedInput3dDir : null,
      errorMessage: null,
    };
  } catch (error: unknown) {
    if (!context.signal.aborted) {
      context.reportProgress({ comfyStatus: 'error', progressText: null,
        errorMessage: error instanceof Error ? error.message : 'ComfyUI video generation failed' });
    }
    throw error;
  } finally {
    context.signal.removeEventListener('abort', stopDisplay);
  }
}
