import assert from 'node:assert/strict';
import test from 'node:test';
import type { Edge, Node } from '@xyflow/react';
import { migrateSavedWorkflow, SAVED_WORKFLOW_SCHEMA_VERSION } from './migrations';

test('loading a ComfyUI node drops legacy probe errors and connection cache', () => {
  const result = migrateSavedWorkflow({ nodes: [{
    id: 'comfy', type: 'comfyVideo', position: { x: 0, y: 0 },
    data: { comfyStatus: 'error', errorMessage: 'fetch failed', comfyOnline: false },
  }], edges: [] });
  assert.equal(result.nodes[0].data.comfyStatus, 'idle');
  assert.equal(result.nodes[0].data.errorMessage, null);
  assert.equal(Object.hasOwn(result.nodes[0].data, 'comfyOnline'), false);
});

test('v1 migration strips removed nodes, handles, and runtime fields', () => {
  const legacyNodes: Node[] = [
    {
      id: 'video',
      type: 'videoUpload',
      position: { x: 0, y: 0 },
      data: {
        label: 'Video Upload',
        videoServerPath: '/uploads/video.mp4',
        uploadStatus: 'done',
      },
    },
    {
      id: 'material',
      type: 'material',
      position: { x: 200, y: 0 },
      data: { textInput: 'brass', textureUrl: '/legacy/texture.png' },
    },
    {
      id: 'mesh',
      type: 'modelGeneration',
      position: { x: 400, y: 0 },
      data: {
        label: 'Mesh Gen',
        layerFiles: ['/legacy/layer.ply'],
        textureUrl: '/legacy/texture.png',
        meshStatus: 'done',
        outputUrl: '/runtime/out.glb',
      },
    },
  ];
  const legacyEdges: Edge[] = [
    { id: 'texture-edge', source: 'material', sourceHandle: 'texture-output', target: 'mesh', targetHandle: 'texture' },
    { id: 'dangling', source: 'material', target: 'missing' },
  ];

  const result = migrateSavedWorkflow({ nodes: legacyNodes, edges: legacyEdges });

  assert.equal(result.schemaVersion, SAVED_WORKFLOW_SCHEMA_VERSION);
  assert.equal(result.nodes.some((node) => node.type === 'material'), false);
  assert.equal(JSON.stringify(result.nodes).includes('layerFiles'), false);
  assert.equal(JSON.stringify(result.nodes).includes('/runtime/out.glb'), false);
  assert.equal(result.edges.some((edge) => edge.targetHandle === 'texture'), false);
  assert.deepEqual(legacyNodes[2].data.layerFiles, ['/legacy/layer.ply']);
});
