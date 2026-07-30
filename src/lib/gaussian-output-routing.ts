export type GaussianMeshOutputHandle = 'splat-output' | 'mesh-output';

export function getPreferredGaussianMeshOutputHandle(data: {
  trainingMode?: unknown;
  trueTrainingAvailable?: unknown;
  sourcePlyUrl?: unknown;
}): GaussianMeshOutputHandle {
  void data.sourcePlyUrl;
  return data.trainingMode === 'train' && data.trueTrainingAvailable === true
    ? 'splat-output'
    : 'mesh-output';
}
