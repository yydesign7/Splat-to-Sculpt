export type DroppedAssetData = {
  assetType: string;
  fileUrl: string;
  fileType: string;
  name: string;
};

function normalizeFileType(fileType: string, fileUrl: string): string {
  const normalized = fileType.trim().toLowerCase();
  if (normalized) return normalized;
  return fileUrl.split('?')[0]?.split('.').pop()?.toLowerCase() || '';
}

function isComfyModelFile(fileType: string, fileUrl: string): boolean {
  const normalized = normalizeFileType(fileType, fileUrl);
  return normalized === 'glb' || normalized === 'gltf' || normalized === 'obj';
}

export function buildAssetDropNodeUpdates(
  assetData: DroppedAssetData,
  targetNodeType: string | undefined,
): Record<string, unknown> | null {
  const { assetType, fileUrl, name } = assetData;
  const fileType = normalizeFileType(assetData.fileType, fileUrl);

  if (assetType === 'video' && targetNodeType === 'videoUpload') {
    return {
      videoServerPath: fileUrl,
      videoUrl: fileUrl,
      coverUrl: null,
      uploadStatus: 'done',
      videoName: name,
    };
  }

  if (assetType === 'pointcloud' && targetNodeType === 'gaussianSplat') {
    return {
      framePaths: [],
      sourcePlyUrl: fileUrl,
      splatUrl: null,
      gaussianCount: null,
      status: 'idle',
      progressText: null,
      progressStep: null,
      errorMessage: null,
      computeBackend: null,
      targetPlyType: null,
      currentTrainingIteration: null,
      maxTrainingIterations: null,
      activeTaskId: null,
    };
  }

  if (assetType === 'pointcloud' && targetNodeType === 'modelGeneration') {
    return {
      modelUrl: fileUrl,
      inputType: 'ply',
      outputUrl: fileUrl,
      outputType: 'ply',
      meshStatus: 'done',
    };
  }

  if (assetType === 'splat' && targetNodeType === 'gaussianSplat') {
    return {
      framePaths: [],
      sourcePlyUrl: fileUrl,
      splatUrl: fileUrl,
      gaussianCount: null,
      status: 'done',
      progressText: null,
      progressStep: null,
      errorMessage: null,
      computeBackend: null,
      targetPlyType: null,
      currentTrainingIteration: null,
      maxTrainingIterations: null,
      activeTaskId: null,
    };
  }

  if (assetType === 'splat' && targetNodeType === 'modelGeneration') {
    return {
      modelUrl: fileUrl,
      inputType: 'splat',
      outputUrl: null,
      outputType: null,
      meshStatus: 'idle',
      errorMessage: null,
    };
  }

  if (assetType === 'model' && targetNodeType === 'modelOrganize') {
    const isGlb = fileType === 'glb' || fileType === 'gltf';
    return { modelUrl: fileUrl, outputUrl: fileUrl, outputType: isGlb ? 'glb' : 'obj' };
  }

  if (assetType === 'model' && targetNodeType === 'modelSurface') {
    return { modelUrl: fileUrl };
  }

  if (assetType === 'model' && targetNodeType === 'modelGeneration') {
    const isPly = fileType === 'ply';
    const isGlb = fileType === 'glb' || fileType === 'gltf';
    const inferredType = isPly ? 'ply' : isGlb ? 'glb' : 'obj';
    return {
      modelUrl: fileUrl,
      inputType: inferredType,
      outputUrl: fileUrl,
      outputType: inferredType,
      meshStatus: 'done',
    };
  }

  if (assetType === 'model' && targetNodeType === 'videoPreview') {
    return { modelUrl: fileUrl };
  }

  if (assetType === 'model' && targetNodeType === 'comfyVideo' && isComfyModelFile(fileType, fileUrl)) {
    return {
      modelUrl: fileUrl,
      videoUrl: null,
      videoName: null,
      promptId: null,
      errorMessage: null,
    };
  }

  if (assetType === 'render-video' && targetNodeType === 'videoPreview') {
    return {
      videoUrl: fileUrl,
      videoName: name,
      modelUrl: null,
      videoGenerating: false,
      errorMessage: null,
    };
  }

  return null;
}
