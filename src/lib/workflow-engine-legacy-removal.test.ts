import assert from 'node:assert/strict';
import test from 'node:test';

import type { Edge, Node } from '@xyflow/react';
import { NODE_TYPE_CONFIGS } from './node-config';
import { computeDownstreamPushes, getNodeTriggerInfo } from './workflow-engine';

test('Material Gen is no longer a registered or executable node type', () => {
  const legacyMaterialNode: Node = {
    id: 'material',
    type: 'material',
    position: { x: 0, y: 0 },
    data: { textInput: 'rusted steel', textureUrl: '/legacy/material.png' },
  };
  const targetNode: Node = {
    id: 'mesh',
    type: 'modelGeneration',
    position: { x: 200, y: 0 },
    data: {},
  };
  const edges: Edge[] = [
    {
      id: 'material-to-mesh',
      source: 'material',
      sourceHandle: 'texture-output',
      target: 'mesh',
      targetHandle: 'texture',
    },
  ];

  assert.equal(NODE_TYPE_CONFIGS.some((config) => config.type === 'material'), false);
  assert.deepEqual(getNodeTriggerInfo(legacyMaterialNode, edges), {
    canTrigger: false,
    reason: 'Unknown node type',
    requiredInputs: [],
    satisfiedInputs: [],
  });
  assert.deepEqual(computeDownstreamPushes(legacyMaterialNode, edges, [legacyMaterialNode, targetNode]), []);
});
