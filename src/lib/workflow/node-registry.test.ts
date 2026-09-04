import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKFLOW_NODE_REGISTRY,
  createDefaultNodeData,
  type WorkflowNodeType,
} from './node-registry';

test('registry is the only source of executable node types and defaults', () => {
  const types = Object.keys(WORKFLOW_NODE_REGISTRY);
  assert.deepEqual(types.sort(), [
    'comfyVideo',
    'frameExtraction',
    'gaussianSplat',
    'modelGeneration',
    'modelOrganize',
    'modelSurface',
    'stickyNote',
    'videoPreview',
    'videoUpload',
  ]);
  assert.equal(types.includes('material'), false);
  for (const type of types) {
    const label = createDefaultNodeData(type as WorkflowNodeType).label;
    assert.equal(typeof label === 'string' && label.length > 0, true);
  }
});

test('registry ports never expose removed legacy contracts', () => {
  const serialized = JSON.stringify(WORKFLOW_NODE_REGISTRY);
  assert.equal(serialized.includes('layerFiles'), false);
  assert.equal(serialized.includes('texture-output'), false);
});
