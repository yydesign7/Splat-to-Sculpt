import { NextRequest, NextResponse } from 'next/server';
import { cp, mkdir } from 'fs/promises';
import path from 'path';
import { DEFAULT_COMFY_VIDEO_PRESET } from '@/lib/comfyui-video-preset';
import {
  deriveSeedanceInstallFolders,
  fileExists,
  SEEDANCE_CUSTOM_NODE_DIRS,
  SEEDANCE_PACK_ROOT,
  SEEDANCE_WORKFLOW_FILES,
} from '@/lib/comfyui-seedance-pack';
import { getComfySystemStats, normalizeComfyUrl } from '@/lib/comfyui-server';

type InstallItem = {
  name: string;
  source: string;
  destination: string;
  status: 'copied' | 'skipped';
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const requestedUrl = (body as { comfyUrl?: string }).comfyUrl;
    const comfyUrl = normalizeComfyUrl(requestedUrl || process.env.COMFYUI_BASE_URL || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl);
    const systemStats = await getComfySystemStats(comfyUrl);
    const installFolders = deriveSeedanceInstallFolders(systemStats);

    if (!installFolders.customNodesDir || !installFolders.workflowsDir) {
      return NextResponse.json(
        { error: 'Could not detect ComfyUI custom_nodes or workflows directory.' },
        { status: 400 },
      );
    }

    const installedCustomNodes: InstallItem[] = [];
    await mkdir(installFolders.customNodesDir, { recursive: true });
    for (const name of SEEDANCE_CUSTOM_NODE_DIRS) {
      const source = path.join(SEEDANCE_PACK_ROOT, 'custom_nodes', name);
      const destination = path.join(installFolders.customNodesDir, name);
      if (await fileExists(destination)) {
        installedCustomNodes.push({ name, source, destination, status: 'skipped' });
        continue;
      }
      await cp(source, destination, { recursive: true, force: false });
      installedCustomNodes.push({ name, source, destination, status: 'copied' });
    }

    const installedWorkflowFiles: InstallItem[] = [];
    await mkdir(installFolders.workflowsDir, { recursive: true });
    for (const name of SEEDANCE_WORKFLOW_FILES) {
      const source = path.join(SEEDANCE_PACK_ROOT, 'workflows', name);
      const destination = path.join(installFolders.workflowsDir, name);
      if (await fileExists(destination)) {
        installedWorkflowFiles.push({ name, source, destination, status: 'skipped' });
        continue;
      }
      await cp(source, destination, { force: false });
      installedWorkflowFiles.push({ name, source, destination, status: 'copied' });
    }

    const copiedCustomNodeCount = installedCustomNodes.filter((item) => item.status === 'copied').length;

    return NextResponse.json({
      success: true,
      comfyUrl,
      customNodesDir: installFolders.customNodesDir,
      workflowsDir: installFolders.workflowsDir,
      installedCustomNodes,
      installedWorkflowFiles,
      restartRequired: copiedCustomNodeCount > 0,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Seedance pack installation failed';
    console.error('[install-comfy-seedance-pack] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
