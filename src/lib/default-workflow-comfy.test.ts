import assert from 'node:assert/strict';
import test from 'node:test';

import type { Edge, Node } from '@xyflow/react';
import { initialEdges, initialNodes } from './default-workflow';
import { getWorkflowNodeDefinition } from './workflow/node-registry';

function applyRegistryPush(sourceNode: Node, edge: Edge, targetNode: Node): Record<string, unknown> | null {
  const sourceDefinition = getWorkflowNodeDefinition(sourceNode.type);
  const targetDefinition = getWorkflowNodeDefinition(targetNode.type);
  if (!sourceDefinition || !targetDefinition) return null;
  const packet = sourceDefinition.readOutput(sourceNode, edge.sourceHandle ?? '');
  if (!packet) return null;
  return targetDefinition.applyInput(targetNode, edge.targetHandle ?? '', packet);
}

test('default workflow routes Surface Processing directly into ComfyUI Video Gen', () => {
  const comfyNode = initialNodes.find((node) => node.type === 'comfyVideo');
  assert.ok(comfyNode, 'default workflow should include ComfyUI Video Gen');

  const meshNodes = initialNodes.filter((node) => node.type === 'modelGeneration');
  assert.equal(meshNodes.length, 1, 'default workflow should only include the first Mesh Gen node');
  assert.equal(
    initialNodes.some((node) => node.id === '8'),
    false,
    'default workflow should remove the final Mesh Gen node',
  );

  const surfaceToComfy = initialEdges.find(
    (edge) =>
      edge.source === '7' &&
      edge.sourceHandle === 'obj-output' &&
      edge.target === comfyNode.id &&
      edge.targetHandle === 'model-input',
  );
  const comfyToPreview = initialEdges.find(
    (edge) =>
      edge.source === comfyNode.id &&
      edge.sourceHandle === 'video-output' &&
      edge.target === '9' &&
      edge.targetHandle === 'video-input',
  );

  assert.ok(surfaceToComfy, 'Surface Processing output should feed ComfyUI Video Gen');
  assert.ok(comfyToPreview, 'ComfyUI video output should feed Video Preview');
  assert.equal(
    initialEdges.some((edge) => edge.source === '8' || edge.target === '8'),
    false,
    'default workflow should not include edges to the removed final Mesh Gen',
  );
});

test('workflow registry routes Surface Processing output to ComfyUI Video Gen', () => {
  const sourceNode: Node = {
    id: 'surface-1',
    type: 'modelSurface',
    position: { x: 0, y: 0 },
    data: {
      outputModelUrl: '/api/ephemeral-file?sid=s1&rel=surface/final.glb',
      lightParams: { exposure: 1.2 },
    },
  };
  const targetNode: Node = {
    id: 'comfy-1',
    type: 'comfyVideo',
    position: { x: 0, y: 0 },
    data: {},
  };
  const edge: Edge = {
    id: 'edge-1',
    source: 'surface-1',
    sourceHandle: 'obj-output',
    target: 'comfy-1',
    targetHandle: 'model-input',
  };

  assert.deepEqual(applyRegistryPush(sourceNode, edge, targetNode), {
    modelUrl: '/api/ephemeral-file?sid=s1&rel=surface/final.glb',
    lightParams: { exposure: 1.2 },
  });
});
