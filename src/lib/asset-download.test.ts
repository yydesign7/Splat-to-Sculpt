import assert from 'node:assert/strict';
import test from 'node:test';

test('buildAssetDownloadFilename preserves the asset extension from its URL', async () => {
  const downloadModule = await import('./asset-download').catch(() => null);
  assert.ok(downloadModule, 'asset download helpers should exist');
  assert.equal(
    downloadModule.buildAssetDownloadFilename('Gaussian splat', '/assets/gaussian_splat.ply'),
    'Gaussian splat.ply'
  );
  assert.equal(
    downloadModule.buildAssetDownloadFilename('finished-model.glb', '/assets/mesh.glb'),
    'finished-model.glb'
  );
});

test('downloadAssetFile fetches the asset and clicks a temporary download link', async () => {
  const downloadModule = await import('./asset-download').catch(() => null);
  assert.ok(downloadModule, 'asset download helpers should exist');

  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const events: string[] = [];
  const anchor = {
    href: '',
    download: '',
    click: () => events.push('click'),
    remove: () => events.push('remove'),
  };

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(new Blob(['model-data']), { status: 200 }),
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tagName: string) => {
        assert.equal(tagName, 'a');
        return anchor;
      },
      body: {
        appendChild: () => events.push('append'),
      },
    },
  });
  URL.createObjectURL = () => 'blob:test-download';
  URL.revokeObjectURL = (url: string) => events.push(`revoke:${url}`);

  try {
    await downloadModule.downloadAssetFile('/assets/mesh.glb', 'mesh.glb');

    assert.equal(anchor.href, 'blob:test-download');
    assert.equal(anchor.download, 'mesh.glb');
    assert.deepEqual(events, ['append', 'click', 'remove', 'revoke:blob:test-download']);
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});
