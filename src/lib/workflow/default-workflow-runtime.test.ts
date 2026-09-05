import assert from 'node:assert/strict';
import test from 'node:test';
import type { Node } from '@xyflow/react';
import { initialEdges, initialNodes } from '../default-workflow';
import { createWorkflowRunner } from './runner';
import type { WorkflowNodeExecutor, WorkflowNodeType } from './types';

interface DeferredPatch {
  promise: Promise<Record<string, unknown>>;
  resolve(value: Record<string, unknown>): void;
}

function deferredPatch(): DeferredPatch {
  let resolvePatch: (value: Record<string, unknown>) => void = () => {};
  const promise = new Promise<Record<string, unknown>>((resolve) => {
    resolvePatch = resolve;
  });
  return { promise, resolve: resolvePatch };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function cloneDefaultNodesWithUploadedVideo(): Node[] {
  return initialNodes.map((node) =>
    node.id === '1'
      ? {
          ...node,
          data: {
            ...node.data,
            uploadStatus: 'done',
            videoServerPath: '/api/ephemeral-file?sid=test&rel=uploads/source.mp4',
            targetFrameCount: 24,
          },
        }
      : { ...node, data: { ...node.data } },
  );
}

test('default workflow runs through the centralized scheduler and pauses at Surface Processing', async () => {
  let nodes = cloneDefaultNodesWithUploadedVideo();
  const started: WorkflowNodeType[] = [];
  const deferred = {
    frameExtraction: deferredPatch(),
    gaussianSplat: deferredPatch(),
    modelGeneration: deferredPatch(),
    modelOrganize: deferredPatch(),
    modelSurface: deferredPatch(),
    comfyVideo: deferredPatch(),
  } satisfies Partial<Record<WorkflowNodeType, DeferredPatch>>;

  const makeExecutor = (type: keyof typeof deferred): WorkflowNodeExecutor => async () => {
    started.push(type);
    return deferred[type].promise;
  };

  const runner = createWorkflowRunner({
    getNodes: () => nodes,
    getEdges: () => initialEdges,
    setNodes: (updater) => {
      nodes = updater(nodes);
    },
    apiFetch: async () => new Response(JSON.stringify({ success: true })),
    ephemeralSessionId: 'test-session',
    executors: {
      frameExtraction: makeExecutor('frameExtraction'),
      gaussianSplat: makeExecutor('gaussianSplat'),
      modelGeneration: makeExecutor('modelGeneration'),
      modelOrganize: makeExecutor('modelOrganize'),
      modelSurface: makeExecutor('modelSurface'),
      comfyVideo: makeExecutor('comfyVideo'),
    },
  });

  const runPromise = runner.run();
  assert.deepEqual(started, ['frameExtraction']);

  deferred.frameExtraction.resolve({
    status: 'done',
    frames: ['/frames/001.jpg'],
    outputFolder: 'frames',
    frameCount: 24,
    targetFrameCount: 24,
  });
  await flushAsyncWork();
  assert.deepEqual(started, ['frameExtraction', 'gaussianSplat']);

  deferred.gaussianSplat.resolve({
    status: 'done',
    splatUrl: '/splat/output.ply',
    sourcePlyUrl: '/splat/source.ply',
    gaussianCount: 123,
  });
  await flushAsyncWork();
  assert.deepEqual(started, ['frameExtraction', 'gaussianSplat', 'modelGeneration']);

  deferred.modelGeneration.resolve({
    meshStatus: 'done',
    outputUrl: '/mesh/output.glb',
    outputType: 'glb',
    layerNames: ['body', 'detail'],
    layerGlbUrls: ['/mesh/body.glb', '/mesh/detail.glb'],
  });
  await flushAsyncWork();
  assert.deepEqual(started, ['frameExtraction', 'gaussianSplat', 'modelGeneration', 'modelOrganize']);

  deferred.modelOrganize.resolve({
    organizeStatus: 'done',
    outputUrl: '/cleanup/output.glb',
    outputType: 'glb',
    layerNames: ['body', 'detail'],
    layerGlbUrls: ['/cleanup/body.glb', '/cleanup/detail.glb'],
  });
  await runPromise;

  assert.equal(runner.getSnapshot().phase, 'waiting-for-user');
  assert.equal(started.includes('modelSurface'), false);

  const surfacePromise = runner.runSingleNode('7');
  assert.deepEqual(started, [
    'frameExtraction',
    'gaussianSplat',
    'modelGeneration',
    'modelOrganize',
    'modelSurface',
  ]);

  deferred.modelSurface.resolve({
    blenderProcessing: false,
    blenderError: null,
    outputModelUrl: '/surface/output.glb',
    outputModelType: 'glb',
    layerNames: ['body', 'detail'],
    layerGlbUrls: ['/cleanup/body.glb', '/cleanup/detail.glb'],
    lightParams: { exposure: 1.1 },
  });
  await flushAsyncWork();
  assert.deepEqual(started, [
    'frameExtraction',
    'gaussianSplat',
    'modelGeneration',
    'modelOrganize',
    'modelSurface',
    'comfyVideo',
  ]);

  deferred.comfyVideo.resolve({
    comfyStatus: 'done',
    progressText: 'ComfyUI video ready',
    videoUrl: '/videos/final.mp4',
    videoName: 'ComfyUI Video',
  });
  await surfacePromise;

  assert.equal(runner.getSnapshot().phase, 'completed');
  assert.equal(runner.getState()?.nodes['9']?.phase, 'succeeded');
  assert.equal(started.includes('videoPreview'), false);
});
