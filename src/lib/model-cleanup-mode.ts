export type ModelCleanupMode = 'single' | 'layers' | 'none';

export function selectModelCleanupMode({
  modelUrl,
  layerGlbUrls,
}: {
  modelUrl: string | null | undefined;
  layerGlbUrls: string[] | null | undefined;
}): ModelCleanupMode {
  if (modelUrl && !modelUrl.startsWith('blob:')) {
    return 'single';
  }
  if (layerGlbUrls && layerGlbUrls.length > 0) {
    return 'layers';
  }
  return 'none';
}
