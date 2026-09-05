import assert from 'node:assert/strict';
import test from 'node:test';
import type { Node } from '@xyflow/react';
import type { WorkflowNodeExecutorContext } from '../types';
import { executeComfyVideo } from './comfy-video';
import { executeModelCleanup } from './model-cleanup';
import { executeSurfaceProcessing } from './surface-processing';
import { executeVideoPreview, getVideoPreviewExecutionMode } from './video-preview';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function node(type: string, data: Record<string, unknown>): Node {
  return { id: type, type, position: { x: 0, y: 0 }, data };
}

function context(params: {
  node: Node;
  responses: unknown[];
  reportProgress?: (patch: Record<string, unknown>) => void;
}): WorkflowNodeExecutorContext & { requests: string[] } {
  const responses = [...params.responses];
  const requests: string[] = [];
  return {
    runId: 'run-1',
    ephemeralSessionId: 'session',
    node: params.node,
    signal: new AbortController().signal,
    requests,
    apiFetch: async (input) => {
      requests.push(String(input));
      const next = responses.shift();
      if (next === undefined) throw new Error('No scripted response');
      return jsonResponse(next);
    },
    reportProgress: params.reportProgress ?? (() => {}),
  };
}

test('cleanup preserves Mesh Gen layer metadata', async () => {
  const result = await executeModelCleanup(context({
    node: node('modelOrganize', {
      modelUrl: '/main.glb',
      layerNames: ['Body', 'Base'],
      layerGlbUrls: ['/body.glb', '/base.glb'],
    }),
    responses: [
      { success: true, glbUrl: '/clean/body.glb' },
      { success: true, glbUrl: '/clean/base.glb' },
      { success: true, mergedGlbUrl: '/clean/merged.glb' },
    ],
  }));

  assert.equal(result.outputUrl, '/clean/merged.glb');
  assert.deepEqual(result.layerNames, ['Body', 'Base']);
  assert.deepEqual(result.layerGlbUrls, ['/clean/body.glb', '/clean/base.glb']);
  assert.equal(Object.hasOwn(result, 'layerFiles'), false);
});

test('surface executor returns processed model output and light params', async () => {
  const lightParams = { exposure: 1.2 };
  const result = await executeSurfaceProcessing(context({
    node: node('modelSurface', {
      modelUrl: '/model.glb',
      materialParams: { roughness: 0.4 },
      layerParams: {},
      lightParams,
      layerNames: ['Body'],
      layerGlbUrls: ['/body.glb'],
    }),
    responses: [{ success: true, mergedGlbUrl: '/surface/merged.glb' }],
  }));

  assert.equal(result.outputModelUrl, '/surface/merged.glb');
  assert.equal(result.outputModelType, 'glb');
  assert.deepEqual(result.lightParams, lightParams);
  assert.deepEqual(result.layerNames, ['Body']);
});

test('video preview is passive for video input and executes for model input', async () => {
  assert.equal(getVideoPreviewExecutionMode({ videoUrl: '/out.mp4' }), 'passive-sink');
  assert.equal(getVideoPreviewExecutionMode({ modelUrl: '/model.glb' }), 'automatic');

  const passive = await executeVideoPreview(context({
    node: node('videoPreview', { videoUrl: '/out.mp4', videoName: 'Render' }),
    responses: [],
  }));
  assert.equal(passive.videoUrl, '/out.mp4');
});

test('Comfy executor returns generated video metadata', async () => {
  const result = await executeComfyVideo(context({
    node: node('comfyVideo', {
      modelUrl: '/model.glb',
      prompt: 'product video',
      comfyUrl: 'http://127.0.0.1:8188',
    }),
    responses: [{
      success: true,
      videoUrl: '/video.mp4',
      videoName: 'Comfy video',
      promptId: 'prompt-1',
      detectedInput3dDir: '/ComfyUI/input/3d',
    }],
  }));

  assert.equal(result.videoUrl, '/video.mp4');
  assert.equal(result.videoName, 'Comfy video');
  assert.equal(result.comfyStatus, 'done');
});
