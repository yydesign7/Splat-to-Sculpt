import { NextRequest, NextResponse } from 'next/server';
import { detectComfyFoldersFromSystemStats } from '@/lib/comfyui-workflow';
import { getComfySystemStats, normalizeComfyUrl, readComfyVersion } from '@/lib/comfyui-server';
import { DEFAULT_COMFY_VIDEO_PRESET } from '@/lib/comfyui-video-preset';

export async function GET(request: NextRequest) {
  try {
    const requestedUrl = request.nextUrl.searchParams.get('comfyUrl');
    const comfyUrl = normalizeComfyUrl(requestedUrl || process.env.COMFYUI_BASE_URL || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl);
    const systemStats = await getComfySystemStats(comfyUrl);
    const detectedFolders = detectComfyFoldersFromSystemStats(systemStats);

    return NextResponse.json({
      success: true,
      online: true,
      comfyUrl,
      version: readComfyVersion(systemStats),
      detectedInputDir: detectedFolders.inputDir,
      detectedOutputDir: detectedFolders.outputDir,
      detectedInput3dDir: detectedFolders.input3dDir,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'ComfyUI status check failed';
    return NextResponse.json({
      success: false,
      online: false,
      error: message,
      detectedInputDir: null,
      detectedOutputDir: null,
      detectedInput3dDir: null,
    });
  }
}
