import assert from 'node:assert/strict';
import test from 'node:test';

import type { Edge, Node } from '@xyflow/react';
import {
  buildComfyVideoPrompt,
  detectComfyFoldersFromSystemStats,
  extractComfyVideoPreset,
  findComfyVideoOutput,
  resolveComfyInput3dDirectory,
} from './comfyui-workflow';
import { compileWorkflowGraph } from './workflow/graph-compiler';
import { getWorkflowNodeDefinition } from './workflow/node-registry';

function applyRegistryPush(sourceNode: Node, edge: Edge, targetNode: Node): Record<string, unknown> | null {
  const sourceDefinition = getWorkflowNodeDefinition(sourceNode.type);
  const targetDefinition = getWorkflowNodeDefinition(targetNode.type);
  if (!sourceDefinition || !targetDefinition) return null;
  const packet = sourceDefinition.readOutput(sourceNode, edge.sourceHandle ?? '');
  if (!packet) return null;
  return targetDefinition.applyInput(targetNode, edge.targetHandle ?? '', packet);
}

const apiWorkflow = {
  '1': {
    class_type: 'Seedance3DModelMultiView',
    inputs: {
      model: ['5', 0],
      scene_selection: '场景全部对象',
      resolution: 1024,
      background: '深灰影棚',
      camera_elevation: 12,
      frame_padding: 1.25,
      render_engine: 'Eevee（快速）',
      force_render: false,
    },
  },
  '2': {
    class_type: 'ByteDance2ReferenceNode',
    inputs: {
      model: 'Seedance 2.0',
      'model.prompt': 'jewelry campaign prompt',
      'model.resolution': '720p',
      'model.ratio': '9:16',
      'model.duration': 10,
      'model.generate_audio': true,
      seed: 20260724,
      watermark: false,
    },
  },
  '3': {
    class_type: 'SaveVideo',
    inputs: {
      video: ['2', 0],
      filename_prefix: 'Seedance_Ads/clips/3d_model_shot',
      format: 'auto',
      codec: 'auto',
    },
  },
  '5': {
    class_type: 'Seedance3DModelLoader',
    inputs: {
      model: 'ring_ai_ref2.fbx',
    },
  },
};

test('extractComfyVideoPreset reads Seedance and multiview defaults from API workflow', () => {
  const preset = extractComfyVideoPreset(apiWorkflow);

  assert.deepEqual(preset, {
    comfyUrl: 'http://127.0.0.1:8000',
    model: 'Seedance 2.0',
    prompt: 'jewelry campaign prompt',
    videoResolution: '720p',
    ratio: '9:16',
    duration: 10,
    generateAudio: true,
    seed: 20260724,
    watermark: false,
    sceneSelection: '场景全部对象',
    renderResolution: 1024,
    background: '深灰影棚',
    cameraElevation: 12,
    framePadding: 1.25,
    renderEngine: 'Eevee（快速）',
    forceRender: false,
    filenamePrefix: 'Seedance_Ads/clips/3d_model_shot',
    format: 'auto',
    codec: 'auto',
  });
});

test('buildComfyVideoPrompt replaces model and node parameters without removing workflow links', () => {
  const prompt = buildComfyVideoPrompt(apiWorkflow, {
    modelFileName: 'splat_to_sculpt_job.glb',
    preset: {
      ...extractComfyVideoPreset(apiWorkflow),
      prompt: 'custom product video',
      duration: 8,
      watermark: true,
    },
  });

  assert.equal(prompt['5'].inputs.model, 'splat_to_sculpt_job.glb');
  assert.equal(prompt['2'].inputs['model.prompt'], 'custom product video');
  assert.equal(prompt['2'].inputs['model.duration'], 8);
  assert.equal(prompt['2'].inputs.watermark, true);
  assert.deepEqual(prompt['1'].inputs.model, ['5', 0]);
  assert.deepEqual(prompt['3'].inputs.video, ['2', 0]);
});

test('workflow registry routes ComfyUI video output to Video Preview', () => {
  const sourceNode: Node = {
    id: 'comfy-1',
    type: 'comfyVideo',
    position: { x: 0, y: 0 },
    data: {
      videoUrl: '/api/ephemeral-file?sid=s1&rel=comfy-videos/out.mp4',
      videoName: 'ComfyUI Video',
      comfyStatus: 'done',
    },
  };
  const targetNode: Node = {
    id: 'preview-1',
    type: 'videoPreview',
    position: { x: 0, y: 0 },
    data: {},
  };
  const edge: Edge = {
    id: 'edge-1',
    source: 'comfy-1',
    sourceHandle: 'video-output',
    target: 'preview-1',
    targetHandle: 'video-input',
  };

  assert.deepEqual(applyRegistryPush(sourceNode, edge, targetNode), {
    videoUrl: '/api/ephemeral-file?sid=s1&rel=comfy-videos/out.mp4',
    videoName: 'ComfyUI Video',
  });
});

test('workflow registry treats ComfyUI Video Gen as model-driven processing node', () => {
  const node: Node = {
    id: 'comfy-1',
    type: 'comfyVideo',
    position: { x: 0, y: 0 },
    data: {
      modelUrl: '/api/ephemeral-file?sid=s1&rel=uploads/model.glb',
      comfyStatus: 'done',
      videoUrl: '/api/ephemeral-file?sid=s1&rel=comfy-videos/out.mp4',
    },
  };
  const edges: Edge[] = [
    { id: 'edge-1', source: 'mesh-1', sourceHandle: 'obj-output', target: 'comfy-1', targetHandle: 'model-input' },
  ];
  const sourceNode: Node = {
    id: 'mesh-1',
    type: 'modelSurface',
    position: { x: 0, y: 0 },
    data: { outputModelUrl: '/api/ephemeral-file?sid=s1&rel=surface/final.glb' },
  };
  const compiled = compileWorkflowGraph([sourceNode, node], edges);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const definition = getWorkflowNodeDefinition(node.type);
  assert.ok(definition);

  assert.deepEqual(
    definition.getReadiness(node, compiled.graph),
    {
      reason: 'Model data ready',
      ready: true,
    },
  );
  assert.equal(definition.getCompletion(node).complete, true);
});

test('findComfyVideoOutput returns SaveVideo result from ComfyUI history', () => {
  const output = findComfyVideoOutput(
    {
      abc123: {
        outputs: {
          '4': {
            images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }],
          },
          '3': {
            videos: [{ filename: 'shot.mp4', subfolder: 'Seedance_Ads/clips', type: 'output' }],
          },
        },
      },
    },
    'abc123',
  );

  assert.deepEqual(output, {
    filename: 'shot.mp4',
    subfolder: 'Seedance_Ads/clips',
    type: 'output',
  });
});

test('detectComfyFoldersFromSystemStats uses explicit ComfyUI input and output directories', () => {
  const folders = detectComfyFoldersFromSystemStats({
    system: {
      argv: [
        '/Applications/ComfyUI/main.py',
        '--input-directory',
        '/Users/a/input',
        '--output-directory',
        '/Users/a/output',
        '--base-directory',
        '/Users/a/base',
      ],
    },
  });

  assert.deepEqual(folders, {
    baseDir: '/Users/a/base',
    inputDir: '/Users/a/input',
    outputDir: '/Users/a/output',
    input3dDir: '/Users/a/input/3d',
  });
});

test('detectComfyFoldersFromSystemStats derives folders from base directory', () => {
  const folders = detectComfyFoldersFromSystemStats({
    system: {
      argv: ['/apps/ComfyUI/main.py', '--base-directory', '/Users/a/ComfyUIData'],
    },
  });

  assert.deepEqual(folders, {
    baseDir: '/Users/a/ComfyUIData',
    inputDir: '/Users/a/ComfyUIData/input',
    outputDir: '/Users/a/ComfyUIData/output',
    input3dDir: '/Users/a/ComfyUIData/input/3d',
  });
});

test('detectComfyFoldersFromSystemStats derives folders from main.py location', () => {
  const folders = detectComfyFoldersFromSystemStats({
    system: {
      argv: ['/opt/ComfyUI/main.py'],
    },
  });

  assert.deepEqual(folders, {
    baseDir: '/opt/ComfyUI',
    inputDir: '/opt/ComfyUI/input',
    outputDir: '/opt/ComfyUI/output',
    input3dDir: '/opt/ComfyUI/input/3d',
  });
});

test('resolveComfyInput3dDirectory prefers manual override, then env, then detection', () => {
  assert.equal(
    resolveComfyInput3dDirectory({
      settingsInput3dDir: '/manual/input/3d',
      envInput3dDir: '/env/input/3d',
      detectedInput3dDir: '/auto/input/3d',
    }),
    '/manual/input/3d',
  );
  assert.equal(
    resolveComfyInput3dDirectory({
      envInput3dDir: '/env/input/3d',
      detectedInput3dDir: '/auto/input/3d',
    }),
    '/env/input/3d',
  );
  assert.equal(
    resolveComfyInput3dDirectory({
      detectedInput3dDir: '/auto/input/3d',
    }),
    '/auto/input/3d',
  );
});
