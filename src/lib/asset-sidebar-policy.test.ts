import assert from 'node:assert/strict';
import test from 'node:test';
import { isListedSidebarAsset } from './asset-sidebar-policy';

test('lists render videos created by ComfyUI Video Gen', () => {
  assert.equal(
    isListedSidebarAsset({
      assetType: 'render-video',
      sourceNode: 'comfyVideo',
      fileType: 'mp4',
      fileUrl: '/asset-published/example/comfy-video.mp4',
    }),
    true,
  );
});

test('lists Mesh Gen OBJ and FBX model outputs in Assets', () => {
  for (const fileType of ['obj', 'fbx'] as const) {
    assert.equal(
      isListedSidebarAsset({
        assetType: 'model',
        sourceNode: 'modelGeneration',
        fileType,
        fileUrl: `/asset-published/example/mesh.${fileType}`,
      }),
      true,
    );
  }
});
