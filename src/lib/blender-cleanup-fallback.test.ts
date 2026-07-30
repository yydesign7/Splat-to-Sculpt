import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCleanupPassthroughResult,
  shouldPassthroughOnBlenderFailure,
} from './blender-cleanup-fallback';

test('passes through the original model when Blender crashes before script JSON output', () => {
  assert.equal(
    shouldPassthroughOnBlenderFailure({
      message: 'Command failed: Blender --background --python script.py',
      code: 139,
      stdout: 'Blender 5.1.1\nWriting: /tmp/blender.crash.txt',
      stderr: '',
      parsedScriptResult: null,
    }),
    true,
  );
});

test('does not pass through when Blender script reports a model processing error', () => {
  assert.equal(
    shouldPassthroughOnBlenderFailure({
      message: 'Command failed: Blender --background --python script.py',
      code: 1,
      stdout: '{"status":"error","error":"Unsupported model format"}',
      stderr: '',
      parsedScriptResult: { status: 'error', error: 'Unsupported model format' },
    }),
    false,
  );
});

test('builds a cleanup result that keeps preview and downstream workflow alive', () => {
  assert.deepEqual(buildCleanupPassthroughResult('/input/chair.glb'), {
    status: 'ok',
    glb_path: '/input/chair.glb',
    obj_path: null,
    vertex_count_before: null,
    vertex_count_after: null,
    face_count_before: null,
    face_count_after: null,
    cleanup_passthrough: true,
  });
});
