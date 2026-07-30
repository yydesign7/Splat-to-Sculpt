import assert from 'node:assert/strict';
import test from 'node:test';
import { getAssetVisualPreview } from './asset-preview';

test('render videos can preview from the video file when no thumbnail was saved', () => {
  const preview = getAssetVisualPreview({
    assetType: 'render-video',
    fileUrl: '/asset-published/example/preview.mp4',
    thumbnailUrl: null,
  });

  assert.equal(preview.smallPreviewUrl, '/asset-published/example/preview.mp4');
  assert.equal(preview.smallPreviewKind, 'video');
  assert.equal(preview.hoverPreviewUrl, '/asset-published/example/preview.mp4');
  assert.equal(preview.hoverPreviewKind, 'video');
});

test('3D model assets use their generated thumbnail for sidebar previews', () => {
  const preview = getAssetVisualPreview({
    assetType: 'model',
    fileUrl: '/asset-published/example/mesh.glb',
    thumbnailUrl: '/asset-published/example/thumbnail.png',
  });

  assert.equal(preview.smallPreviewUrl, '/asset-published/example/thumbnail.png');
  assert.equal(preview.smallPreviewKind, 'image');
  assert.equal(preview.hoverPreviewUrl, '/asset-published/example/thumbnail.png');
  assert.equal(preview.hoverPreviewKind, 'image');
});
