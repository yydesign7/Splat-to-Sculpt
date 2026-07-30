export type MeshAssetOutputType = 'glb' | 'fbx' | 'obj' | 'ply' | 'splat' | null;

const PUBLISHABLE_MESH_MODEL_TYPES = new Set(['glb', 'fbx', 'obj']);

function isGltfLikeUrl(url: string): boolean {
  const normalized = decodeURIComponent(url).toLowerCase();
  return normalized.endsWith('.glb') || normalized.endsWith('.gltf') || normalized.includes('.glb') || normalized.includes('.gltf');
}

export function shouldPublishMeshGenerationAsset(params: {
  outputType: MeshAssetOutputType;
  outputUrl: string | null | undefined;
  hasDownstream?: boolean;
}): boolean {
  if (!params.outputUrl || params.outputUrl.startsWith('blob:')) return false;
  return PUBLISHABLE_MESH_MODEL_TYPES.has(params.outputType || '');
}

export type MeshGenerationAssetCandidate =
  | {
      kind: 'merge-layers';
      fileType: 'glb';
      fileUrl: null;
      layerGlbUrls: string[];
      layerNames: string[];
    }
  | {
      kind: 'main-output';
      fileType: 'glb' | 'fbx' | 'obj';
      fileUrl: string;
      layerGlbUrls: [];
      layerNames: [];
    }
  | null;

export function selectMeshGenerationAssetCandidate(params: {
  outputType: MeshAssetOutputType;
  outputUrl: string | null | undefined;
  layerGlbUrls?: string[] | null;
  layerNames?: string[] | null;
}): MeshGenerationAssetCandidate {
  const validLayerGlbs = (params.layerGlbUrls || []).filter((url) => (
    typeof url === 'string' && !!url.trim() && !url.startsWith('blob:') && isGltfLikeUrl(url)
  ));
  if (validLayerGlbs.length > 0) {
    return {
      kind: 'merge-layers',
      fileType: 'glb',
      fileUrl: null,
      layerGlbUrls: validLayerGlbs,
      layerNames: (params.layerNames || []).slice(0, validLayerGlbs.length),
    };
  }

  if (!shouldPublishMeshGenerationAsset({ outputType: params.outputType, outputUrl: params.outputUrl })) {
    return null;
  }

  return {
    kind: 'main-output',
    fileType: params.outputType as 'glb' | 'fbx' | 'obj',
    fileUrl: params.outputUrl as string,
    layerGlbUrls: [],
    layerNames: [],
  };
}
