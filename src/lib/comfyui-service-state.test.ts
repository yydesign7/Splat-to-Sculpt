import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyComfyService, readComfyProbe } from './comfyui-service-state';

test('unreachable automatic discovery is setup guidance, previously configured service is disconnected', () => {
  assert.equal(classifyComfyService('unreachable', { explicitAddress: false, connectedBefore: false }), 'unconfigured');
  assert.equal(classifyComfyService('unreachable', { explicitAddress: true, connectedBefore: false }), 'disconnected');
  assert.equal(classifyComfyService('unreachable', { explicitAddress: false, connectedBefore: true }), 'disconnected');
  assert.equal(classifyComfyService('probe-failed', { explicitAddress: false, connectedBefore: false }), 'check-failed');
});

test('malformed application response is not mistaken for an unconfigured service', () => {
  assert.throws(() => readComfyProbe({ error: 'server exception' }), /Invalid/);
  assert.throws(() => readComfyProbe({ kind: 'connected', online: false }), /Invalid/);
});
