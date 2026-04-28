/** Shape needed for sidebar listing policy (matches asset-library / Sidebar entries). */
export type AssetListFields = {
  assetType: 'video' | 'pointcloud' | 'model' | 'render-video';
  sourceNode: string;
  fileType: string;
  fileUrl: string;
};

/**
 * Assets tab policy: only user uploads (video, PLY), workflow render videos,
 * and terminal 3DGS model-generation GLB outputs (enforced at write time; this
 * filters legacy rows that may still exist in assets.json).
 */
export function isListedSidebarAsset(entry: AssetListFields): boolean {
  const { assetType, sourceNode, fileType, fileUrl } = entry;
  const ft = (fileType || '').toLowerCase();
  const urlLower = (fileUrl || '').toLowerCase().split('?')[0] || '';

  if (assetType === 'video') {
    return sourceNode === 'videoUpload';
  }
  if (assetType === 'pointcloud') {
    return sourceNode === 'pointCloud';
  }
  if (assetType === 'render-video') {
    return sourceNode === 'videoPreview';
  }
  if (assetType === 'model') {
    if (sourceNode !== 'modelGeneration') return false;
    return ft === 'glb' || urlLower.endsWith('.glb');
  }
  return false;
}
