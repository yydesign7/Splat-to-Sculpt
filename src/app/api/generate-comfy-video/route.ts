import { NextRequest, NextResponse } from 'next/server';
import { access, copyFile, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  buildComfyVideoPrompt,
  detectComfyFoldersFromSystemStats,
  findComfyVideoOutput,
  mergeComfyVideoSettings,
  resolveComfyInput3dDirectory,
  type ComfyVideoRunSettings,
} from '@/lib/comfyui-workflow';
import { fetchComfyJson, getComfySystemStats, getPromptId, normalizeComfyUrl } from '@/lib/comfyui-server';
import {
  COMFY_3D_MODEL_TO_VIDEO_WORKFLOW,
  DEFAULT_COMFY_VIDEO_PRESET,
} from '@/lib/comfyui-video-preset';
import {
  buildEphemeralFileUrl,
  getEphemeralSessionFromRequest,
  getSessionRoot,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';

const SUPPORTED_COMFY_MODEL_EXTS = new Set(['.blend', '.fbx', '.glb', '.gltf', '.obj']);

async function waitForComfyVideo(comfyUrl: string, promptId: string): Promise<{ filename: string; subfolder?: string; type?: string }> {
  const timeoutMs = 45 * 60 * 1000;
  const intervalMs = 2500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const history = await fetchComfyJson(`${comfyUrl}/history/${encodeURIComponent(promptId)}`);
    const output = findComfyVideoOutput(history, promptId);
    if (output) return output;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for ComfyUI video output');
}

export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const { modelUrl, settings } = body as {
      modelUrl?: string;
      settings?: ComfyVideoRunSettings;
    };

    if (!modelUrl) {
      return NextResponse.json({ error: 'No model file path provided' }, { status: 400 });
    }

    const sourceModelPath = resolveClientMediaUrlToFilesystem(modelUrl);
    await access(sourceModelPath);

    const ext = path.extname(sourceModelPath).toLowerCase();
    if (!SUPPORTED_COMFY_MODEL_EXTS.has(ext)) {
      return NextResponse.json(
        { error: `ComfyUI 3D model workflow supports ${Array.from(SUPPORTED_COMFY_MODEL_EXTS).join(', ')} files` },
        { status: 400 },
      );
    }

    const preset = mergeComfyVideoSettings(DEFAULT_COMFY_VIDEO_PRESET, settings || {});
    const comfyUrl = normalizeComfyUrl(
      settings?.comfyUrl || process.env.COMFYUI_BASE_URL || preset.comfyUrl,
    );

    const systemStats = await getComfySystemStats(comfyUrl);
    const detectedFolders = detectComfyFoldersFromSystemStats(systemStats);
    const comfyInputDir = resolveComfyInput3dDirectory({
      settingsInput3dDir: settings?.comfyInput3dDir,
      envInput3dDir: process.env.COMFYUI_3D_INPUT_DIR,
      detectedInput3dDir: detectedFolders.input3dDir,
    });
    if (!comfyInputDir) {
      return NextResponse.json(
        { error: 'Could not detect ComfyUI input/3d directory. Please set the node override path.' },
        { status: 400 },
      );
    }

    const jobId = randomUUID();
    await mkdir(comfyInputDir, { recursive: true });
    const comfyModelFileName = `splat_to_sculpt_${jobId}${ext}`;
    await copyFile(sourceModelPath, path.join(comfyInputDir, comfyModelFileName));

    const prompt = buildComfyVideoPrompt(COMFY_3D_MODEL_TO_VIDEO_WORKFLOW, {
      modelFileName: comfyModelFileName,
      preset,
    });

    const clientId = randomUUID();
    const promptResponse = await fetchComfyJson(`${comfyUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
    });
    const promptId = getPromptId(promptResponse);

    const output = await waitForComfyVideo(comfyUrl, promptId);
    const params = new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder || '',
      type: output.type || 'output',
    });
    const outputRes = await fetch(`${comfyUrl}/view?${params.toString()}`);
    if (!outputRes.ok) {
      throw new Error(`Failed to download ComfyUI output (${outputRes.status})`);
    }

    const outputDir = path.join(getSessionRoot(sessionId), 'comfy-videos', jobId);
    await mkdir(outputDir, { recursive: true });
    const outputExt = path.extname(output.filename) || '.mp4';
    const outputFileName = `comfy_video${outputExt}`;
    await writeFile(path.join(outputDir, outputFileName), Buffer.from(await outputRes.arrayBuffer()));

    return NextResponse.json({
      success: true,
      videoUrl: buildEphemeralFileUrl(sessionId, `comfy-videos/${jobId}/${outputFileName}`),
      videoName: 'ComfyUI Video',
      promptId,
      comfyModelFileName,
      detectedInputDir: detectedFolders.inputDir,
      detectedOutputDir: detectedFolders.outputDir,
      detectedInput3dDir: comfyInputDir,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'ComfyUI video generation failed';
    console.error('[generate-comfy-video] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
