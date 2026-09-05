import assert from 'node:assert/strict';
import test from 'node:test';
import type { Edge, Node } from '@xyflow/react';
import { createWorkflowRunner } from './runner';
import type { WorkflowNodeExecutor, WorkflowNodeType } from './types';

function node(id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

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
