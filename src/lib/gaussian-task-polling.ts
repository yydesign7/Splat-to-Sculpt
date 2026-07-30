export const GAUSSIAN_TASK_TIMEOUT_MS = 16 * 60 * 1000;
export const GAUSSIAN_TASK_POLL_INTERVAL_MS = 2000;

export function getGaussianTaskMaxPollAttempts(params: {
  timeoutMs: number;
  intervalMs: number;
}): number {
  const timeoutMs = Math.max(0, params.timeoutMs);
  const intervalMs = Math.max(1, params.intervalMs);
  return Math.ceil(timeoutMs / intervalMs);
}

export const GAUSSIAN_TASK_MAX_POLL_ATTEMPTS = getGaussianTaskMaxPollAttempts({
  timeoutMs: GAUSSIAN_TASK_TIMEOUT_MS,
  intervalMs: GAUSSIAN_TASK_POLL_INTERVAL_MS,
});
