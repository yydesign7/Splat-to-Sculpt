import type { ComfyApiWorkflow, ComfyVideoPreset } from './comfyui-workflow';
import { extractComfyVideoPreset } from './comfyui-workflow';

export const COMFY_3D_MODEL_TO_VIDEO_WORKFLOW: ComfyApiWorkflow = {
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
    _meta: { title: 'Seedance3DModelMultiView' },
  },
  '2': {
    class_type: 'ByteDance2ReferenceNode',
    inputs: {
      model: 'Seedance 2.0',
      'model.prompt':
        '图片1至图片9是同一枚首饰从不同角度渲染的严格结构参考。必须保持戒圈轮廓、镶爪数量、主石形状、辅石数量、金属颜色、比例和所有设计细节完全一致，不要混合角度，不要增加或删除部件。高端珠宝商业广告，深色影棚，电影级布光，真实微距摄影。镜头从正面英雄角度缓慢推进，产品在展台上平稳旋转，展示侧面镶嵌结构，最后停在主石微距特写。不要文字，不要标志，不要包装盒，不要额外首饰，不要手指遮挡，不要改变产品设计。',
      'model.resolution': '720p',
      'model.ratio': '9:16',
      'model.duration': 10,
      'model.generate_audio': true,
      'model.reference_images.image_1': ['1', 1],
      'model.reference_images.image_2': ['1', 2],
      'model.reference_images.image_3': ['1', 3],
      'model.reference_images.image_4': ['1', 4],
      'model.reference_images.image_5': ['1', 5],
      'model.reference_images.image_6': ['1', 6],
      'model.reference_images.image_7': ['1', 7],
      'model.reference_images.image_8': ['1', 8],
      'model.reference_images.image_9': ['1', 9],
      'model.auto_downscale': false,
      seed: 20260724,
      watermark: false,
    },
    _meta: { title: 'ByteDance2ReferenceNode' },
  },
  '3': {
    class_type: 'SaveVideo',
    inputs: {
      video: ['2', 0],
      filename_prefix: 'Seedance_Ads/clips/3d_model_shot',
      format: 'auto',
      codec: 'auto',
    },
    _meta: { title: 'SaveVideo' },
  },
  '4': {
    class_type: 'PreviewImage',
    inputs: {
      images: ['1', 0],
    },
    _meta: { title: 'PreviewImage' },
  },
  '5': {
    class_type: 'Seedance3DModelLoader',
    inputs: {
      model: 'ring_ai_ref2.fbx',
    },
    _meta: { title: 'Seedance3DModelLoader' },
  },
};

export const DEFAULT_COMFY_VIDEO_PRESET: ComfyVideoPreset = extractComfyVideoPreset(COMFY_3D_MODEL_TO_VIDEO_WORKFLOW);

export function buildDefaultComfyVideoNodeData(): Record<string, unknown> {
  return {
    label: 'ComfyUI Video Gen',
    modelUrl: null,
    videoUrl: null,
    videoName: null,
    comfyStatus: 'idle',
    progressText: null,
    errorMessage: null,
    promptId: null,
    comfyInput3dDir: null,
    detectedInputDir: null,
    detectedOutputDir: null,
    detectedInput3dDir: null,
    comfyOnline: null,
    comfyVersion: null,
    ...DEFAULT_COMFY_VIDEO_PRESET,
  };
}
