export type ModelCleanupMode = 'single' | 'layers' | 'none';

export function selectModelCleanupMode({
  modelUrl,
  layerGlbUrls,
}: {
  modelUrl: string | null | undefined;
  layerGlbUrls: string[] | null | undefined;
}): ModelCleanupMode {
  if (layerGlbUrls && layerGlbUrls.length > 0) {
    return 'layers';
  }
  if (modelUrl && !modelUrl.startsWith('blob:')) {
    return 'single';
  }
  return 'none';
}
