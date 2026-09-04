import assert from 'node:assert/strict';
import test from 'node:test';

import type { Edge, Node } from '@xyflow/react';
import { sanitizeLoadedWorkflowGraph } from './workflow-load-sanitizer';

test('loading a legacy workflow removes Material Gen, dangling edges, and layerFiles without mutating the source graph', () => {
  const nodes: Node[] = [
    {
      id: 'gaussian',
      type: 'gaussianSplat',
      position: { x: 0, y: 0 },
      data: {
        sourcePlyUrl: '/legacy/source.ply',
        layerFiles: ['/legacy/layer-0.ply'],
        layerNames: ['Legacy point-cloud layer'],
      },
    },
    {
      id: 'material',
      type: 'material',
      position: { x: 200, y: 0 },
      data: { textInput: 'rusted steel', textureUrl: '/legacy/material.png' },
    },
    {
      id: 'mesh',
      type: 'modelGeneration',
      position: { x: 400, y: 0 },
      data: {
        layerFiles: ['/legacy/layer-0.ply'],
        layerNames: ['Body'],
        layerGlbUrls: ['/layers/body.glb'],
      },
    },
    {
      id: 'surface',
      type: 'modelSurface',
      position: { x: 600, y: 0 },
      data: {
        layerFiles: ['/legacy/layer-0.ply'],
        layerNames: ['Body'],
        layerGlbUrls: ['/layers/body.glb'],
      },
    },
  ];
  const edges: Edge[] = [
    { id: 'gaussian-to-material', source: 'gaussian', target: 'material' },
    { id: 'material-to-mesh', source: 'material', target: 'mesh' },
    { id: 'gaussian-to-mesh', source: 'gaussian', target: 'mesh' },
    { id: 'mesh-to-surface', source: 'mesh', target: 'surface' },
    { id: 'dangling', source: 'missing-node', target: 'surface' },
  ];

  const sanitized = sanitizeLoadedWorkflowGraph(nodes, edges);

  assert.deepEqual(
    sanitized.nodes.map((node) => node.id),
    ['gaussian', 'mesh', 'surface'],
  );
  assert.deepEqual(
    sanitized.edges.map((edge) => edge.id),
    ['gaussian-to-mesh', 'mesh-to-surface'],
  );
  assert.equal(Object.hasOwn(sanitized.nodes[0].data, 'layerFiles'), false);
  assert.equal(Object.hasOwn(sanitized.nodes[0].data, 'layerNames'), false);
  assert.equal(Object.hasOwn(sanitized.nodes[1].data, 'layerFiles'), false);
  assert.deepEqual(sanitized.nodes[1].data.layerNames, ['Body']);
  assert.deepEqual(sanitized.nodes[1].data.layerGlbUrls, ['/layers/body.glb']);
  assert.equal(Object.hasOwn(sanitized.nodes[2].data, 'layerFiles'), false);
  assert.deepEqual(sanitized.nodes[2].data.layerNames, ['Body']);
  assert.deepEqual(sanitized.nodes[2].data.layerGlbUrls, ['/layers/body.glb']);

  assert.deepEqual(nodes[0].data.layerFiles, ['/legacy/layer-0.ply']);
  assert.equal(nodes.some((node) => node.type === 'material'), true);
  assert.equal(edges.length, 5);
});
