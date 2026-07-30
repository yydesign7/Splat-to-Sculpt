import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSeedanceInstallFolders,
  missingRequiredNodeTypes,
  readLoadedNodeTypes,
  SEEDANCE_WORKFLOW_FILES,
} from './comfyui-seedance-pack';

test('derives Seedance install folders from ComfyUI data directory', () => {
  const folders = deriveSeedanceInstallFolders({
    system: {
      argv: ['/apps/ComfyUI/main.py', '--base-directory', '/Users/a/Documents/ComfyUI'],
    },
  });

  assert.deepEqual(folders, {
    customNodesDir: '/Users/a/Documents/ComfyUI/custom_nodes',
    workflowsDir: '/Users/a/Documents/ComfyUI/user/default/workflows',
  });
});

test('derives Seedance install folders from explicit input directory parent', () => {
  const folders = deriveSeedanceInstallFolders({
    system: {
      argv: ['/apps/ComfyUI/main.py', '--input-directory', '/Users/a/Documents/input'],
    },
  });

  assert.deepEqual(folders, {
    customNodesDir: '/Users/a/Documents/custom_nodes',
    workflowsDir: '/Users/a/Documents/user/default/workflows',
  });
});

test('detects missing Seedance node types from ComfyUI object info', () => {
  const loaded = readLoadedNodeTypes({
    Seedance3DModelLoader: {},
    Seedance3DModelMultiView: {},
    SaveVideo: {},
  });

  assert.deepEqual(missingRequiredNodeTypes(loaded), ['ByteDance2ReferenceNode']);
});

test('installs only the editable ComfyUI workflow JSON into user workflows', () => {
  assert.deepEqual([...SEEDANCE_WORKFLOW_FILES], ['Seedance2_3Dmodel_to_image_video.json']);
});
