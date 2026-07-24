import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClearedWorkflowGraph } from './workflow-clear';

test('clear regenerates node ids and preserves edge topology', () => {
  const nodes = [
    {
      id: 'video-1',
      type: 'videoUpload',
      selected: true,
      dragging: true,
      position: { x: 0, y: 0 },
      data: { videoUrl: '/old.mp4' },
    },
    {
      id: 'frames-1',
      type: 'frameExtraction',
      selected: true,
      dragging: true,
      position: { x: 100, y: 0 },
      data: { frames: ['/old-frame.jpg'] },
    },
  ];
  const edges = [
    {
      id: 'edge-1',
      source: 'video-1',
      target: 'frames-1',
      sourceHandle: 'output',
      targetHandle: 'input',
    },
  ];

  const cleared = buildClearedWorkflowGraph(
    nodes,
    edges,
    (node) => ({ label: node.type, cleared: true }),
    {
      nodeIdFactory: (node) => `${node.id}-cleared`,
      edgeIdFactory: (edge) => `${edge.id}-cleared`,
    },
  );

  assert.deepEqual(
    cleared.nodes.map((node) => node.id),
    ['video-1-cleared', 'frames-1-cleared'],
  );
  assert.deepEqual(cleared.nodes.map((node) => node.data), [
    { label: 'videoUpload', cleared: true },
    { label: 'frameExtraction', cleared: true },
  ]);
  assert.equal(cleared.nodes[0].selected, false);
  assert.equal(cleared.nodes[0].dragging, false);
  assert.deepEqual(cleared.edges[0], {
    id: 'edge-1-cleared',
    source: 'video-1-cleared',
    target: 'frames-1-cleared',
    sourceHandle: 'output',
    targetHandle: 'input',
    selected: false,
  });

  const staleAsyncUpdate = cleared.nodes.map((node) =>
    node.id === 'video-1'
      ? { ...node, data: { videoUrl: '/stale.mp4' } }
      : node,
  );
  assert.deepEqual(staleAsyncUpdate, cleared.nodes);
});
