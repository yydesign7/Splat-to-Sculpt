import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GAUSSIAN_TASK_POLL_INTERVAL_MS,
  GAUSSIAN_TASK_TIMEOUT_MS,
  getGaussianTaskMaxPollAttempts,
} from './gaussian-task-polling';

test('Gaussian task polling waits for 16 minutes at the current polling cadence', () => {
  const attempts = getGaussianTaskMaxPollAttempts({
    timeoutMs: GAUSSIAN_TASK_TIMEOUT_MS,
    intervalMs: GAUSSIAN_TASK_POLL_INTERVAL_MS,
  });

  assert.equal(GAUSSIAN_TASK_TIMEOUT_MS, 16 * 60 * 1000);
  assert.equal(GAUSSIAN_TASK_POLL_INTERVAL_MS, 2000);
  assert.equal(attempts, 480);
});
