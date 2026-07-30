import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssetDropNodeUpdates } from './asset-drop-mapping';

test('maps render video assets directly into Video Preview playback', () => {
  const updates = buildAssetDropNodeUpdates(
    {
      assetType: 'render-video',
      fileUrl: '/asset-published/example/render.mp4',
      fileType: 'mp4',
      name: 'Render Preview',
    },
    'videoPreview',
  );

  assert.deepEqual(updates, {
    videoUrl: '/asset-published/example/render.mp4',
    videoName: 'Render Preview',
    modelUrl: null,
    videoGenerating: false,
    errorMessage: null,
  });
});

test('maps GLB model assets into ComfyUI Video Gen model input', () => {
  const updates = buildAssetDropNodeUpdates(
    {
      assetType: 'model',
      fileUrl: '/asset-published/example/mesh.glb',
      fileType: 'glb',
      name: 'Mesh',
    },
    'comfyVideo',
  );

  assert.deepEqual(updates, {
    modelUrl: '/asset-published/example/mesh.glb',
    videoUrl: null,
    videoName: null,
    promptId: null,
    errorMessage: null,
  });
});

test('keeps GLB model assets usable as Video Preview model inputs', () => {
  const updates = buildAssetDropNodeUpdates(
    {
      assetType: 'model',
      fileUrl: '/asset-published/example/mesh.glb',
      fileType: 'glb',
      name: 'Mesh',
    },
    'videoPreview',
  );

  assert.deepEqual(updates, { modelUrl: '/asset-published/example/mesh.glb' });
});

test('does not treat render videos as ComfyUI model inputs', () => {
  const updates = buildAssetDropNodeUpdates(
    {
      assetType: 'render-video',
      fileUrl: '/asset-published/example/render.mp4',
      fileType: 'mp4',
      name: 'Render Preview',
    },
    'comfyVideo',
  );

  assert.equal(updates, null);
});

test('ignores model assets dropped on unsupported nodes', () => {
  const updates = buildAssetDropNodeUpdates(
    {
      assetType: 'model',
      fileUrl: '/asset-published/example/mesh.glb',
      fileType: 'glb',
      name: 'Mesh',
    },
    'frameExtraction',
  );

  assert.equal(updates, null);
});
