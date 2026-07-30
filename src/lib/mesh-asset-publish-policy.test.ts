import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMeshGenerationAssetCandidate, shouldPublishMeshGenerationAsset } from './mesh-asset-publish-policy';

test('publishes Mesh Gen GLB, OBJ and FBX outputs regardless of downstream links', () => {
  for (const outputType of ['glb', 'obj', 'fbx'] as const) {
    assert.equal(
      shouldPublishMeshGenerationAsset({
        outputType,
        outputUrl: `/api/ephemeral-file?sid=11111111-1111-4111-8111-111111111111&rel=meshes%2Fjob%2Fmesh.${outputType}`,
        hasDownstream: true,
      }),
      true,
    );
  }
});

test('does not publish Mesh Gen PLY outputs as 3D model assets', () => {
  assert.equal(
    shouldPublishMeshGenerationAsset({
      outputType: 'ply',
      outputUrl: '/api/ephemeral-file?sid=11111111-1111-4111-8111-111111111111&rel=meshes%2Fjob%2Fmesh.ply',
      hasDownstream: false,
    }),
    false,
  );
});

test('prefers merging layer GLBs into one layered asset when layer outputs exist', () => {
  assert.deepEqual(
    selectMeshGenerationAssetCandidate({
      outputType: 'obj',
      outputUrl: '/api/ephemeral-file?sid=11111111-1111-4111-8111-111111111111&rel=meshes%2Fjob%2Fmesh.obj',
      layerGlbUrls: [
        '/api/ephemeral-file?sid=11111111-1111-4111-8111-111111111111&rel=meshes%2Fjob%2Flayers%2Flayer_000_planar.glb',
        '/api/ephemeral-file?sid=11111111-1111-4111-8111-111111111111&rel=meshes%2Fjob%2Flayers%2Flayer_001_curved.glb',
      ],
      layerNames: ['seat', 'legs'],
    }),
    {
      kind: 'merge-layers',
      fileType: 'glb',
      fileUrl: null,
      layerGlbUrls: [
        '/api/ephemeral-file?sid=11111111-1111-4111-8111-111111111111&rel=meshes%2Fjob%2Flayers%2Flayer_000_planar.glb',
        '/api/ephemeral-file?sid=11111111-1111-4111-8111-111111111111&rel=meshes%2Fjob%2Flayers%2Flayer_001_curved.glb',
      ],
      layerNames: ['seat', 'legs'],
    },
  );
});

test('falls back to the main model output when no layer GLBs exist', () => {
  assert.deepEqual(
    selectMeshGenerationAssetCandidate({
      outputType: 'fbx',
      outputUrl: '/asset-published/example/mesh.fbx',
      layerGlbUrls: [],
      layerNames: [],
    }),
    {
      kind: 'main-output',
      fileType: 'fbx',
      fileUrl: '/asset-published/example/mesh.fbx',
      layerGlbUrls: [],
      layerNames: [],
    },
  );
});
