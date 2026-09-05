import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { GET } from './route';

test('connection refusal returns an ordinary unreachable probe result', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
  });
  const response = await GET(new NextRequest('http://localhost/api/comfy-video-status?comfyUrl=http://127.0.0.1:8188'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).kind, 'unreachable');
});

test('invalid URL and application faults remain distinguishable from unavailable service', async (t) => {
  const invalid = await GET(new NextRequest('http://localhost/api/comfy-video-status?comfyUrl=https://example.com'));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).kind, 'invalid-url');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected failure'); });
  const failed = await GET(new NextRequest('http://localhost/api/comfy-video-status'));
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).kind, 'probe-failed');
});

test('reachable ComfyUI returns connection metadata', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ system: { comfyui_version: '1.0' } }));
  const response = await GET(new NextRequest('http://localhost/api/comfy-video-status'));
  const result = await response.json();
  assert.equal(result.kind, 'connected');
  assert.equal(result.version, '1.0');
});

test('probe passes its five-second deadline to the upstream request', async (t) => {
  let deadline = 0;
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    deadline = milliseconds;
    return AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
  });
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    throw new Error('Probe did not forward its deadline');
  });
  const response = await GET(new NextRequest('http://localhost/api/comfy-video-status'));
  assert.equal(deadline, 5000);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).kind, 'unreachable');
});
