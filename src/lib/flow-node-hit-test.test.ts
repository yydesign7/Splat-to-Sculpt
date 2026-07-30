import assert from 'node:assert/strict';
import test from 'node:test';
import { findDropTargetNode } from './flow-node-hit-test';

test('uses measured node dimensions when deciding asset drop targets', () => {
  const nodes = [
    {
      id: 'video-preview-1',
      type: 'videoPreview',
      position: { x: 100, y: 100 },
      measured: { width: 340, height: 470 },
    },
  ];

  const target = findDropTargetNode(nodes, { x: 260, y: 430 });

  assert.equal(target?.id, 'video-preview-1');
});

test('falls back to larger Video Preview bounds before React Flow measurements are available', () => {
  const nodes = [
    {
      id: 'video-preview-1',
      type: 'videoPreview',
      position: { x: 100, y: 100 },
    },
  ];

  const target = findDropTargetNode(nodes, { x: 260, y: 430 });

  assert.equal(target?.id, 'video-preview-1');
});

test('does not match points outside fallback node bounds', () => {
  const nodes = [
    {
      id: 'mesh-1',
      type: 'modelGeneration',
      position: { x: 100, y: 100 },
    },
  ];

  const target = findDropTargetNode(nodes, { x: 260, y: 430 });

  assert.equal(target, null);
});
