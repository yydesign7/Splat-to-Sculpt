import assert from 'node:assert/strict';
import test from 'node:test';
import type { Edge, Node } from '@xyflow/react';
import { createWorkflowRunner } from './runner';
import type { WorkflowNodeExecutor, WorkflowNodeType } from './types';
import { executeComfyVideo } from './executors/comfy-video';

function node(id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

test('ComfyUI execution failure and retry agree with runner state and propagate the video', async () => {
  let nodes = [node('comfy', 'comfyVideo', { modelUrl: '/model.glb', comfyStatus: 'idle' }), node('preview', 'videoPreview')];
  const edges: Edge[] = [{ id: 'video', source: 'comfy', sourceHandle: 'video-output', target: 'preview', targetHandle: 'video-input' }];
  let online = false;
  const runner = createWorkflowRunner({
    getNodes: () => nodes, getEdges: () => edges, setNodes: (update) => { nodes = update(nodes); },
    apiFetch: async (input) => {
      if (String(input).includes('comfy-video-status')) return Response.json({ kind: online ? 'connected' : 'unreachable', online });
      if (String(input).includes('comfy-seedance-status')) return Response.json({ success: true, ready: true });
      return Response.json({ success: true, videoUrl: '/new.mp4' });
    },
    executors: { comfyVideo: executeComfyVideo },
  });
  assert.equal(runner.getSnapshot().error, null);
  await runner.runSingleNode('comfy');
  assert.equal(runner.getSnapshot().phase, 'failed');
  assert.equal(nodes[0].data.comfyStatus, 'error');
  online = true;
  await runner.runSingleNode('comfy');
  assert.equal(nodes[0].data.comfyStatus, 'done');
  assert.equal(nodes[0].data.errorMessage, null);
  assert.equal(nodes[1].data.videoUrl, '/new.mp4');
  assert.equal(runner.getSnapshot().phase, 'completed');
});

test('stopped ComfyUI runs cannot replace a new run or remove its cancellation controller', async () => {
  let nodes = [node('comfy', 'comfyVideo', { modelUrl: '/model.glb', comfyStatus: 'idle', videoUrl: '/old.mp4' })];
  const responses: Array<(response: Response) => void> = [];
  const runner = createWorkflowRunner({
    getNodes: () => nodes, getEdges: () => [], setNodes: (update) => { nodes = update(nodes); },
    apiFetch: async () => new Promise<Response>((resolve) => responses.push(resolve)),
    executors: { comfyVideo: executeComfyVideo },
  });
  const first = runner.runSingleNode('comfy');
  runner.stop();
  assert.equal(nodes[0].data.comfyStatus, 'idle');
  assert.equal(nodes[0].data.videoUrl, '/old.mp4');
  const second = runner.runSingleNode('comfy');
  responses[0](Response.json({ kind: 'connected', online: true }));
  await first;
  assert.equal(nodes[0].data.comfyStatus, 'processing');
  runner.stop();
  assert.equal(nodes[0].data.comfyStatus, 'idle');
  responses[1](Response.json({ kind: 'connected', online: true }));
  await second;
  assert.equal(nodes[0].data.videoUrl, '/old.mp4');
  assert.equal(runner.getSnapshot().phase, 'cancelled');
});

function makeExecutor(patch: Record<string, unknown>): WorkflowNodeExecutor & { calls: string[] } {
  const calls: string[] = [];
  const executor = (async ({ node }) => {
    calls.push(node.id);
    return patch;
  }) as WorkflowNodeExecutor & { calls: string[] };
  executor.calls = calls;
  return executor;
}

test('runner starts each ready executor once and propagates one result once', async () => {
  let nodes = [
    node('upload', 'videoUpload', { uploadStatus: 'done', videoServerPath: '/video.mp4', targetFrameCount: 24 }),
    node('frames', 'frameExtraction', {}),
    node('gaussian', 'gaussianSplat', {}),
  ];
  const edges: Edge[] = [
    { id: 'e1', source: 'upload', sourceHandle: 'output', target: 'frames', targetHandle: 'input' },
    { id: 'e2', source: 'frames', sourceHandle: 'output', target: 'gaussian', targetHandle: 'input' },
  ];
  const frameExtraction = makeExecutor({
    status: 'done',
    frames: ['/f1.jpg'],
    outputFolder: 'frames',
    frameCount: 24,
    targetFrameCount: 24,
  });
  const gaussianSplat = makeExecutor({
    status: 'done',
    splatUrl: '/splat.ply',
    sourcePlyUrl: '/source.ply',
    gaussianCount: 12,
  });
  let gaussianInputWrites = 0;
  const runner = createWorkflowRunner({
    getNodes: () => nodes,
    getEdges: () => edges,
    setNodes: (updater) => {
      const prevGaussian = nodes.find((candidate) => candidate.id === 'gaussian')?.data.framePaths;
      nodes = updater(nodes);
      const nextGaussian = nodes.find((candidate) => candidate.id === 'gaussian')?.data.framePaths;
      if (prevGaussian !== nextGaussian && Array.isArray(nextGaussian)) gaussianInputWrites += 1;
    },
    apiFetch: async () => okResponse(),
    executors: { frameExtraction, gaussianSplat },
  });

  await runner.run();

  assert.equal(frameExtraction.calls.length, 1);
  assert.equal(gaussianSplat.calls.length, 1);
  assert.equal(gaussianInputWrites, 1);
  assert.equal(runner.getSnapshot().phase, 'completed');
});

test('result from a stopped run cannot update nodes', async () => {
  let nodes = [
    node('upload', 'videoUpload', { uploadStatus: 'done', videoServerPath: '/video.mp4' }),
    node('frames', 'frameExtraction', {}),
  ];
  const edges: Edge[] = [
    { id: 'e1', source: 'upload', sourceHandle: 'output', target: 'frames', targetHandle: 'input' },
  ];
  let resolveExecutor: (patch: Record<string, unknown>) => void = () => {};
  const frameExtraction = (async () => new Promise<Record<string, unknown>>((resolve) => {
    resolveExecutor = resolve;
  })) as WorkflowNodeExecutor;
  const runner = createWorkflowRunner({
    getNodes: () => nodes,
    getEdges: () => edges,
    setNodes: (updater) => {
      nodes = updater(nodes);
    },
    apiFetch: async () => okResponse(),
    executors: { frameExtraction },
  });

  const firstRun = runner.run();
  runner.stop();
  resolveExecutor({ status: 'done', frames: ['/stale.jpg'] });
  await firstRun;

  assert.equal(JSON.stringify(nodes).includes('/stale.jpg'), false);
  assert.equal(runner.getSnapshot().phase, 'cancelled');
});
