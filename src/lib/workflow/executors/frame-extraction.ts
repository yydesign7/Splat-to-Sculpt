import type { WorkflowNodeExecutorContext } from '../types';

interface FrameExtractionResponse {
  success?: boolean;
  frames?: unknown;
  outputFolder?: unknown;
  frameCount?: unknown;
  error?: unknown;
}

function readFrameCount(value: unknown): number {
  return typeof value === 'number' && value >= 1 && value <= 300 ? value : 120;
}

export async function executeFrameExtraction(
  context: WorkflowNodeExecutorContext,
): Promise<Record<string, unknown>> {
  const videoPath = context.node.data.videoServerPath;
  if (typeof videoPath !== 'string' || videoPath.length === 0) {
    throw new Error('Missing video input');
  }

  const frameCount = readFrameCount(context.node.data.targetFrameCount);
  context.reportProgress({ status: 'extracting', errorMessage: null });
  const response = await context.apiFetch('/api/extract-frames', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoPath, frameCount }),
    signal: context.signal,
  });
  const result = (await response.json()) as FrameExtractionResponse;
  if (!result.success) {
    throw new Error(typeof result.error === 'string' ? result.error : 'Frame extraction failed');
  }
  if (!Array.isArray(result.frames)) throw new Error('Frame extraction returned no frames');

  const actualFrameCount = readFrameCount(result.frameCount);
  return {
    frames: result.frames,
    outputFolder: typeof result.outputFolder === 'string' ? result.outputFolder : null,
    frameCount: actualFrameCount,
    targetFrameCount: actualFrameCount,
    status: 'done',
    errorMessage: null,
  };
}
