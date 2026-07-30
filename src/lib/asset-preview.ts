export type AssetPreviewType = 'video' | 'pointcloud' | 'splat' | 'model' | 'render-video';

export type AssetPreviewFields = {
  assetType: AssetPreviewType;
  fileUrl: string;
  thumbnailUrl: string | null;
};

export type AssetVisualPreview = {
  smallPreviewUrl: string | null;
  smallPreviewKind: 'image' | 'video' | 'icon';
  hoverPreviewUrl: string | null;
  hoverPreviewKind: 'image' | 'video' | 'none';
};

export function getAssetVisualPreview(entry: AssetPreviewFields): AssetVisualPreview {
  const thumbnailUrl = entry.thumbnailUrl || null;

  if (entry.assetType === 'video' || entry.assetType === 'render-video') {
    const previewUrl = thumbnailUrl || entry.fileUrl || null;
    const previewKind = thumbnailUrl ? 'image' : 'video';
    return {
      smallPreviewUrl: previewUrl,
      smallPreviewKind: previewUrl ? previewKind : 'icon',
      hoverPreviewUrl: previewUrl,
      hoverPreviewKind: previewUrl ? previewKind : 'none',
    };
  }

  return {
    smallPreviewUrl: thumbnailUrl,
    smallPreviewKind: thumbnailUrl ? 'image' : 'icon',
    hoverPreviewUrl: thumbnailUrl,
    hoverPreviewKind: thumbnailUrl ? 'image' : 'none',
  };
}
