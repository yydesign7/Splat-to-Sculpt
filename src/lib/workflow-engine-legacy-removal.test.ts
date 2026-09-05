import assert from 'node:assert/strict';
import test from 'node:test';

import type { Edge, Node } from '@xyflow/react';
import { NODE_TYPE_CONFIGS } from './node-config';
import { compileWorkflowGraph } from './workflow/graph-compiler';
import { getWorkflowNodeDefinition } from './workflow/node-registry';

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
  assert.equal(getWorkflowNodeDefinition(legacyMaterialNode.type), null);
  assert.deepEqual(compileWorkflowGraph([legacyMaterialNode, targetNode], edges), {
    ok: false,
    diagnostics: [
      {
        code: 'UNKNOWN_NODE_TYPE',
        message: 'Unknown node type "material"',
        nodeId: 'material',
      },
    ],
  });
});
