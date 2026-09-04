import { buildDefaultComfyVideoNodeData } from '@/lib/comfyui-video-preset';
import type { WorkflowNodeType } from './types';

const DEFAULT_LIGHT_PARAMS = {
  ambientIntensity: 0.6,
  mainLightIntensity: 0.8,
  mainLightColor: [1, 1, 1],
  mainLightAzimuth: 45,
  mainLightElevation: 45,
  fillLightIntensity: 0.3,
  fillLightAzimuth: -135,
  fillLightElevation: 30,
  exposure: 1.0,
};

const DEFAULT_MATERIAL_PARAMS = {
  base_color: [0.8, 0.75, 0.7],
  metallic: 0.0,
  roughness: 0.5,
  emissive_color: [0.0, 0.0, 0.0],
  emissive_strength: 0.0,
  alpha: 1.0,
  normal_scale: 1.0,
};

export function createNodeDefaultData(type: WorkflowNodeType): Record<string, unknown> {
  switch (type) {
    case 'videoUpload':
      return {
        label: 'Video Upload',
        videoUrl: null,
        coverUrl: null,
        videoName: null,
        videoServerPath: null,
        uploadStatus: 'idle',
        uploadError: null,
        targetFrameCount: 120,
      };
    case 'frameExtraction':
      return {
        label: 'Frame Extraction',
        videoServerPath: null,
        targetFrameCount: 120,
        frames: [],
        outputFolder: null,
        frameCount: 0,
        status: 'idle',
        errorMessage: null,
      };
    case 'gaussianSplat':
      return {
        label: 'Gaussian Splat Gen',
        framePaths: [],
        sourcePlyUrl: null,
        splatUrl: null,
        gaussianCount: null,
        status: 'idle',
        progressText: null,
        progressStep: null,
        errorMessage: null,
        trainingIterations: 1000,
        currentTrainingIteration: null,
        maxTrainingIterations: null,
        activeTaskId: null,
        deviceType: null,
        computeBackend: null,
        trainingMode: 'auto',
        targetPlyType: null,
        trueTrainingAvailable: null,
        trueTrainingUnavailableReason: null,
      };
    case 'modelGeneration':
      return {
        label: 'Mesh Gen',
        modelUrl: null,
        isFullscreen: false,
        inputType: null,
        outputUrl: null,
        outputType: null,
        meshStatus: 'idle',
        outputFormat: 'glb',
        errorMessage: null,
        faceCount: null,
        gaussianCount: null,
        computeBackend: null,
        renderUrl: null,
        lightParams: null,
        layerNames: [],
        layerGlbUrls: [],
      };
    case 'modelOrganize':
      return {
        label: 'Model Cleanup',
        modelUrl: null,
        outputUrl: null,
        outputType: null,
        isFullscreen: false,
        organizeStatus: 'idle',
        errorMessage: null,
        layerNames: [],
        layerGlbUrls: [],
      };
    case 'modelSurface':
      return {
        label: 'Surface Processing',
        materialFileName: null,
        materialPreviewUrl: null,
        modelUrl: null,
        outputModelUrl: null,
        outputModelType: null,
        selectedLayer: null,
        blenderProcessing: false,
        blenderError: null,
        materialParams: structuredClone(DEFAULT_MATERIAL_PARAMS),
        renderUrl: null,
        layerParams: {},
        lightParams: structuredClone(DEFAULT_LIGHT_PARAMS),
        layerNames: [],
        layerGlbUrls: [],
        layerUrlA: {},
        layerUrlB: {},
        layerUrlC: {},
      };
    case 'comfyVideo':
      return buildDefaultComfyVideoNodeData();
    case 'videoPreview':
      return {
        label: 'Video Preview',
        videoUrl: null,
        videoName: null,
        modelUrl: null,
        videoGenerating: false,
        errorMessage: null,
        lightParams: null,
      };
    case 'stickyNote':
      return {
        label: 'Sticky Note',
        text: 'Write a note...',
      };
  }
}
