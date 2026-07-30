import assert from 'node:assert/strict';
import test from 'node:test';

import { getPreferredGaussianMeshOutputHandle } from './gaussian-output-routing';

test('Gaussian Splat routes true training output to Mesh Gen through splat-output', () => {
  assert.equal(
    getPreferredGaussianMeshOutputHandle({
      trainingMode: 'train',
      trueTrainingAvailable: true,
    }),
    'splat-output',
  );
});

test('Gaussian Splat routes initializer and uploaded PLY paths to Mesh Gen through mesh-output', () => {
  assert.equal(
    getPreferredGaussianMeshOutputHandle({
      trainingMode: 'auto',
      trueTrainingAvailable: true,
    }),
    'mesh-output',
  );
  assert.equal(
    getPreferredGaussianMeshOutputHandle({
      trainingMode: 'train',
      trueTrainingAvailable: false,
    }),
    'mesh-output',
  );
  assert.equal(
    getPreferredGaussianMeshOutputHandle({
      trainingMode: 'auto',
      sourcePlyUrl: '/api/ephemeral-file?sid=s1&rel=upload/chair.ply',
    }),
    'mesh-output',
  );
});
