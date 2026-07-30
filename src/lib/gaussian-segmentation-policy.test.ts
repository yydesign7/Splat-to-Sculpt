import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRunGaussianAutoLayers } from './gaussian-segmentation-policy';

test('Gaussian Splat ignores legacy auto layer requests', () => {
  assert.equal(shouldRunGaussianAutoLayers({ requested: true, hasPly: true, hasFrames: false }), false);
  assert.equal(shouldRunGaussianAutoLayers({ requested: true, hasPly: false, hasFrames: true }), false);
});
