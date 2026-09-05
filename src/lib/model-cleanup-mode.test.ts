import assert from 'node:assert/strict';
import test from 'node:test';

import { selectModelCleanupMode } from './model-cleanup-mode';

test('cleans layer files when both main model and layer files are available', () => {
  assert.equal(
    selectModelCleanupMode({
      modelUrl: '/api/ephemeral-file?sid=s&rel=meshes/mesh.glb',
      layerGlbUrls: ['/api/ephemeral-file?sid=s&rel=layers/layer_000.glb'],
    }),
    'layers',
  );
});

test('cleans layer files only when no main model is available', () => {
  assert.equal(
    selectModelCleanupMode({
      modelUrl: null,
      layerGlbUrls: ['/api/ephemeral-file?sid=s&rel=layers/layer_000.glb'],
    }),
    'layers',
  );
});

test('waits when the main model is still a browser blob URL', () => {
  assert.equal(
    selectModelCleanupMode({
      modelUrl: 'blob:http://localhost/model',
      layerGlbUrls: [],
    }),
    'none',
  );
});
