import assert from 'node:assert/strict';
import test from 'node:test';
import type { Edge, Node } from '@xyflow/react';
import { compileWorkflowGraph } from './graph-compiler';
import { createWorkflowRunState } from './runtime-state';
import { workflowRunReducer, type WorkflowRunAction } from './runtime-reducer';
import { findReadyNodeIds, isRunComplete } from './scheduler';

function node(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function compile(nodes: Node[], edges: Edge[]) {
  const result = compileWorkflowGraph(nodes, edges);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid test graph');
  return result.graph;
}

function reduceActions(state: ReturnType<typeof createWorkflowRunState>, actions: WorkflowRunAction[]) {
  return actions.reduce((current, action) => workflowRunReducer(current, action), state);
}

test('one node starts only once per run and stale completions are ignored', () => {
  const graph = compile([node('mesh', 'modelGeneration', { modelUrl: '/in.ply' })], []);
  const running = reduceActions(createWorkflowRunState('run-2', graph), [
    { type: 'NODE_STARTED', runId: 'run-2', nodeId: 'mesh' },
    { type: 'NODE_STARTED', runId: 'run-2', nodeId: 'mesh' },
    { type: 'NODE_SUCCEEDED', runId: 'run-1', nodeId: 'mesh', patch: { outputUrl: '/stale.glb' } },
  ]);

  assert.equal(running.nodes.mesh.phase, 'running');
  assert.equal(running.nodes.mesh.attempt, 1);
});

test('independent ready branches are returned in one scheduler pass', () => {
  const graph = compile(
    [
      node('upload', 'videoUpload', { uploadStatus: 'done', videoServerPath: '/video.mp4' }),
      node('branch-a', 'frameExtraction', { videoServerPath: '/video.mp4' }),
      node('branch-b', 'frameExtraction', { videoServerPath: '/video.mp4' }),
    ],
    [
      { id: 'a', source: 'upload', sourceHandle: 'output', target: 'branch-a', targetHandle: 'input' },
      { id: 'b', source: 'upload', sourceHandle: 'output', target: 'branch-b', targetHandle: 'input' },
    ],
  );
  const state = workflowRunReducer(createWorkflowRunState('run-1', graph), {
    type: 'NODE_SUCCEEDED',
    runId: 'run-1',
    nodeId: 'upload',
    patch: {},
  });

  assert.deepEqual(findReadyNodeIds(graph, state).sort(), ['branch-a', 'branch-b']);
});

test('completed manual source unlocks automatic successors', () => {
  const graph = compile(
    [
      node('upload', 'videoUpload', { uploadStatus: 'done', videoServerPath: '/video.mp4' }),
      node('frames', 'frameExtraction', { videoServerPath: '/video.mp4' }),
    ],
    [{ id: 'edge', source: 'upload', sourceHandle: 'output', target: 'frames', targetHandle: 'input' }],
  );
  const state = workflowRunReducer(createWorkflowRunState('run-1', graph), {
    type: 'NODE_SUCCEEDED',
    runId: 'run-1',
    nodeId: 'upload',
    patch: {},
  });

  assert.deepEqual(findReadyNodeIds(graph, state), ['frames']);
});

test('interactive node makes the run wait for user action before successors start', () => {
  const graph = compile(
    [
      node('cleanup', 'modelOrganize', { organizeStatus: 'done', outputUrl: '/clean.glb' }),
      node('surface', 'modelSurface', { modelUrl: '/clean.glb' }),
      node('video', 'comfyVideo', { modelUrl: '/surface.glb' }),
    ],
    [
      { id: 'surface-edge', source: 'cleanup', sourceHandle: 'obj-output', target: 'surface', targetHandle: 'obj-input' },
      { id: 'video-edge', source: 'surface', sourceHandle: 'obj-output', target: 'video', targetHandle: 'model-input' },
    ],
  );
  const state = workflowRunReducer(createWorkflowRunState('run-1', graph), {
    type: 'NODE_SUCCEEDED',
    runId: 'run-1',
    nodeId: 'cleanup',
    patch: {},
  });

  assert.deepEqual(findReadyNodeIds(graph, state), []);
  assert.equal(state.phase, 'waiting-for-user');
  assert.equal(isRunComplete(graph, state), false);
});
