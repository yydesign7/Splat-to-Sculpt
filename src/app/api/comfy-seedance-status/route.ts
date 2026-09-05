import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { DEFAULT_COMFY_VIDEO_PRESET } from '@/lib/comfyui-video-preset';
import {
  deriveSeedanceInstallFolders,
  fileExists,
  missingRequiredNodeTypes,
  readLoadedNodeTypes,
  SEEDANCE_CUSTOM_NODE_DIRS,
  SEEDANCE_WORKFLOW_FILES,
} from '@/lib/comfyui-seedance-pack';
import { fetchComfyJson, getComfySystemStats, normalizeComfyUrl } from '@/lib/comfyui-server';

export async function GET(request: NextRequest) {
  try {
    const requestedUrl = request.nextUrl.searchParams.get('comfyUrl');
    const comfyUrl = normalizeComfyUrl(requestedUrl || process.env.COMFYUI_BASE_URL || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    const systemStats = await getComfySystemStats(comfyUrl, signal);
    const installFolders = deriveSeedanceInstallFolders(systemStats);

    const installedCustomNodes = installFolders.customNodesDir
      ? await Promise.all(
          SEEDANCE_CUSTOM_NODE_DIRS.map(async (name) => ({
            name,
            installed: await fileExists(path.join(installFolders.customNodesDir as string, name)),
          })),
        )
      : SEEDANCE_CUSTOM_NODE_DIRS.map((name) => ({ name, installed: false }));
    const installedWorkflowFiles = installFolders.workflowsDir
      ? await Promise.all(
          SEEDANCE_WORKFLOW_FILES.map(async (name) => ({
            name,
            installed: await fileExists(path.join(installFolders.workflowsDir as string, name)),
          })),
        )
      : SEEDANCE_WORKFLOW_FILES.map((name) => ({ name, installed: false }));

    let loadedNodeTypes: string[] = [];
    let objectInfoError: string | null = null;
    try {
      loadedNodeTypes = readLoadedNodeTypes(await fetchComfyJson(`${comfyUrl}/object_info`, { signal }));
    } catch (error: unknown) {
      objectInfoError = error instanceof Error ? error.message : 'Could not read ComfyUI object info';
    }

    const missingNodeTypes = missingRequiredNodeTypes(loadedNodeTypes);
    const missingCustomNodeFolders = installedCustomNodes
      .filter((item) => !item.installed)
      .map((item) => item.name);
    const missingWorkflowFiles = installedWorkflowFiles
      .filter((item) => !item.installed)
      .map((item) => item.name);

    return NextResponse.json({
      success: true,
      comfyUrl,
      customNodesDir: installFolders.customNodesDir,
      workflowsDir: installFolders.workflowsDir,
      installedCustomNodes,
      installedWorkflowFiles,
      missingCustomNodeFolders,
      missingWorkflowFiles,
      loadedNodeTypes,
      missingNodeTypes,
      objectInfoError,
      installed: missingCustomNodeFolders.length === 0 && missingWorkflowFiles.length === 0,
      loaded: missingNodeTypes.length === 0,
      ready: missingCustomNodeFolders.length === 0 && missingNodeTypes.length === 0,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Seedance pack status check failed';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
