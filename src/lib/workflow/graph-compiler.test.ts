import assert from 'node:assert/strict';
import test from 'node:test';
import type { Edge, Node } from '@xyflow/react';
import { compileWorkflowGraph } from './graph-compiler';

function node(id: string, type: string): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} };
}

test('compiler accepts the default-compatible executable chain', () => {
  const nodes = [
    node('video', 'videoUpload'),
    node('frames', 'frameExtraction'),
    node('gaussian', 'gaussianSplat'),
    node('mesh', 'modelGeneration'),
    node('note', 'stickyNote'),
  ];
  const edges: Edge[] = [
    { id: 'e1', source: 'video', sourceHandle: 'output', target: 'frames', targetHandle: 'input' },
    { id: 'e2', source: 'frames', sourceHandle: 'output', target: 'gaussian', targetHandle: 'input' },
    { id: 'e3', source: 'gaussian', sourceHandle: 'splat-output', target: 'mesh', targetHandle: 'model-input' },
  ];

  const result = compileWorkflowGraph(nodes, edges);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.graph.topologicalOrder, ['video', 'frames', 'gaussian', 'mesh']);
    assert.deepEqual(result.graph.annotationNodeIds, ['note']);
  }
});

test('compiler rejects cycles and incompatible ports', () => {
  const cyclicNodes = [
    node('video', 'videoUpload'),
    node('frames', 'frameExtraction'),
    node('mesh', 'modelGeneration'),
  ];
  const cyclicEdges: Edge[] = [
    { id: 'e1', source: 'video', sourceHandle: 'output', target: 'frames', targetHandle: 'input' },
    { id: 'e2', source: 'frames', sourceHandle: 'output', target: 'video', targetHandle: 'output' },
    { id: 'e3', source: 'video', sourceHandle: 'output', target: 'mesh', targetHandle: 'model-input' },
  ];

  const result = compileWorkflowGraph(cyclicNodes, cyclicEdges);

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((item) => item.code === 'GRAPH_CYCLE'), true);
  assert.equal(result.diagnostics.some((item) => item.code === 'INCOMPATIBLE_PORTS'), true);
});
