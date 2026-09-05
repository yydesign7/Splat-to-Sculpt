import { NextRequest, NextResponse } from 'next/server';
import { detectComfyFoldersFromSystemStats } from '@/lib/comfyui-workflow';
import { getComfySystemStats, isComfyConnectionFailure, normalizeComfyUrl, readComfyVersion } from '@/lib/comfyui-server';
import { DEFAULT_COMFY_VIDEO_PRESET } from '@/lib/comfyui-video-preset';

export async function GET(request: NextRequest) {
  let comfyUrl: string;
  try {
    const requestedUrl = request.nextUrl.searchParams.get('comfyUrl');
    comfyUrl = normalizeComfyUrl(requestedUrl || process.env.COMFYUI_BASE_URL || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl);
  } catch (error: unknown) {
    return NextResponse.json({ kind: 'invalid-url', online: false, detail: error instanceof Error ? error.message : 'Invalid URL' }, { status: 400 });
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    const systemStats = await getComfySystemStats(comfyUrl, signal);
    if (!systemStats || typeof systemStats !== 'object' || !('system' in systemStats)) {
      throw new Error('Invalid ComfyUI system stats response');
    }
    const detectedFolders = detectComfyFoldersFromSystemStats(systemStats);

    return NextResponse.json({
      success: true,
      kind: 'connected',
      detail: null,
      online: true,
      comfyUrl,
      version: readComfyVersion(systemStats),
      detectedInputDir: detectedFolders.inputDir,
      detectedOutputDir: detectedFolders.outputDir,
      detectedInput3dDir: detectedFolders.input3dDir,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'ComfyUI status check failed';
    const unavailable = isComfyConnectionFailure(error);
    return NextResponse.json({
      success: false,
      kind: unavailable ? 'unreachable' : 'probe-failed',
      online: false,
      detail: message,
      detectedInputDir: null,
      detectedOutputDir: null,
      detectedInput3dDir: null,
    }, { status: unavailable ? 200 : 500 });
  }
}
