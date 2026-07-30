import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUploadedVideoServerPath } from './uploaded-video-asset';

test('uses the published asset URL after video upload is recorded in Assets', () => {
  const ephemeralUrl = '/api/ephemeral-file?sid=11111111-1111-4111-8111-111111111111&rel=videos%2Fjob%2Finput.mp4';

  assert.equal(
    resolveUploadedVideoServerPath(ephemeralUrl, {
      success: true,
      entry: {
        fileUrl: '/asset-published/asset_123/input.mp4',
      },
    }),
    '/asset-published/asset_123/input.mp4',
  );
});

test('keeps the temporary upload URL when asset recording fails', () => {
  const ephemeralUrl = '/api/ephemeral-file?sid=11111111-1111-4111-8111-111111111111&rel=videos%2Fjob%2Finput.mp4';

  assert.equal(
    resolveUploadedVideoServerPath(ephemeralUrl, {
      success: false,
      error: 'Asset recording failed',
    }),
    ephemeralUrl,
  );
});
