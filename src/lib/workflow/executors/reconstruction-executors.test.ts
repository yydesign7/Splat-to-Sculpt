import assert from 'node:assert/strict';
import test from 'node:test';
import type { Node } from '@xyflow/react';
import type { WorkflowNodeExecutorContext } from '../types';
import { executeFrameExtraction } from './frame-extraction';
import { executeGaussianSplat } from './gaussian-splat';
import { executeMeshGeneration } from './mesh-generation';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeNode(type: string, data: Record<string, unknown>): Node {
  return { id: type, type, position: { x: 0, y: 0 }, data };
}

function makeContext(params: {
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

test('frame extraction executor returns the frame output patch', async () => {
  const context = makeContext({
    node: makeNode('frameExtraction', { videoServerPath: '/video.mp4', targetFrameCount: 24 }),
    responses: [{ success: true, frames: ['/f1.jpg'], outputFolder: 'frames', frameCount: 24 }],
  });

  const result = await executeFrameExtraction(context);

  assert.deepEqual(result, {
    frames: ['/f1.jpg'],
    outputFolder: 'frames',
    frameCount: 24,
    targetFrameCount: 24,
    status: 'done',
    errorMessage: null,
  });
  assert.equal(context.requests[0], '/api/extract-frames');
});

test('Gaussian executor reports progress and returns only current output fields', async () => {
  const patches: Record<string, unknown>[] = [];
  const context = makeContext({
    node: makeNode('gaussianSplat', {
      framePaths: ['/f1.jpg'],
      trainingIterations: 1000,
      trainingMode: 'auto',
    }),
    responses: [
      { success: true, taskId: 'task-1', deviceType: 'cuda', trainingMode: 'train' },
      { status: 'processing', progress: 'Training', progressStep: 3, computeBackend: 'cuda' },
      {
        status: 'done',
        result: {
          splatUrl: '/api/ephemeral-file?id=session&path=out.ply',
          sourcePlyUrl: '/api/ephemeral-file?id=session&path=source.ply',
          gaussianCount: 42,
          format: '3dgs-ply',
        },
        deviceType: 'cuda',
        trainingMode: 'train',
      },
    ],
    reportProgress: (patch) => patches.push(patch),
  });

  const result = await executeGaussianSplat(context);

  assert.equal(patches[0].status, 'processing');
  assert.equal(patches.some((patch) => patch.progressText === 'Training'), true);
  assert.equal(result.status, 'done');
  assert.equal(result.splatUrl, '/api/ephemeral-file?id=session&path=out.ply');
  assert.equal(Object.hasOwn(result, 'layerFiles'), false);
});

test('Mesh executor returns layer metadata without legacy layerFiles', async () => {
  const context = makeContext({
    node: makeNode('modelGeneration', {
      modelUrl: '/source.ply',
      inputType: 'ply',
      outputFormat: 'glb',
    }),
    responses: [
      { success: true, taskId: 'mesh-task' },
      {
        status: 'done',
        result: {
          meshUrl: '/mesh.glb',
          meshFormat: 'glb',
          faceCount: 128,
          layerNames: ['Body'],
          layerGlbUrls: ['/body.glb'],
        },
      },
    ],
  });

  const result = await executeMeshGeneration(context);

  assert.equal(result.meshStatus, 'done');
  assert.deepEqual(result.layerNames, ['Body']);
  assert.deepEqual(result.layerGlbUrls, ['/body.glb']);
  assert.equal(Object.hasOwn(result, 'layerFiles'), false);
});
