import type { Edge, Node } from '@xyflow/react';

export const DEFAULT_WORKFLOW_ID = 'preset_default_workflow';
export const DEFAULT_WORKFLOW_NAME = 'Default Workflow';
export const DEFAULT_WORKFLOW_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export const initialNodes: Node[] = [
  // Row 1: Main pipeline
  {
    id: '1',
    type: 'videoUpload',
    position: { x: 50, y: 80 },
    data: { label: 'Video Upload', videoUrl: null, coverUrl: null, videoName: null, videoServerPath: null, uploadStatus: 'idle', uploadError: null, targetFrameCount: 120 },
  },
  {
    id: '2',
    type: 'frameExtraction',
    position: { x: 400, y: 80 },
    data: { label: 'Frame Extraction', videoServerPath: null, targetFrameCount: 120, frames: [], outputFolder: null, frameCount: 0, status: 'idle', errorMessage: null },
  },
  {
    id: 'gs1',
    type: 'gaussianSplat',
    position: { x: 750, y: 80 },
    data: { label: 'Gaussian Splat Gen', framePaths: [], sourcePlyUrl: null, splatUrl: null, gaussianCount: null, status: 'idle', progressText: null, progressStep: null, errorMessage: null, trainingIterations: 1000, currentTrainingIteration: null, maxTrainingIterations: null, activeTaskId: null, deviceType: null, computeBackend: null, trainingMode: 'auto', targetPlyType: null, trueTrainingAvailable: null, trueTrainingUnavailableReason: null, enableFastSegmentation: true, layerFiles: [], layerNames: [] },
  },
  {
    id: '4',
    type: 'modelGeneration',
    position: { x: 1100, y: 80 },
    data: { label: 'Mesh Gen', modelUrl: null, isFullscreen: false, inputType: null, outputUrl: null, outputType: null, textureUrl: null, meshStatus: 'idle', outputFormat: 'glb', errorMessage: null, faceCount: null, gaussianCount: null, computeBackend: null, renderUrl: null, lightParams: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  },
  // Model cleanup: directly below first Mesh Gen (id 4, x=1100)
  {
    id: '10',
    type: 'modelOrganize',
    position: { x: 1100, y: 430 },
    data: { label: 'Model Cleanup', modelUrl: null, outputUrl: null, outputType: null, isFullscreen: false, organizeStatus: 'idle', errorMessage: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  },
  // Surface: top-aligned with first Mesh Gen (id 4, y=80)
  {
    id: '7',
    type: 'modelSurface',
    position: { x: 1450, y: 80 },
    data: { label: 'Surface Processing', materialFileName: null, materialPreviewUrl: null, modelUrl: null, outputModelUrl: null, outputModelType: null, selectedLayer: null, blenderProcessing: false, blenderError: null, materialParams: { base_color: [0.8, 0.75, 0.7], metallic: 0.0, roughness: 0.5, emissive_color: [0.0, 0.0, 0.0], emissive_strength: 0.0, alpha: 1.0, normal_scale: 1.0 }, renderUrl: null, layerParams: {}, lightParams: { ambientIntensity: 0.6, mainLightIntensity: 0.8, mainLightColor: [1, 1, 1], mainLightAzimuth: 45, mainLightElevation: 45, fillLightIntensity: 0.3, fillLightAzimuth: -135, fillLightElevation: 30, exposure: 1.0 }, layerFiles: [], layerNames: [], layerGlbUrls: [], layerUrlA: {}, layerUrlB: {}, layerUrlC: {} },
  },
  // Second Mesh Gen: top-aligned with surface (y=80)
  {
    id: '8',
    type: 'modelGeneration',
    position: { x: 1800, y: 80 },
    data: { label: 'Mesh Gen', modelUrl: null, isFullscreen: false, inputType: null, outputUrl: null, outputType: null, textureUrl: null, meshStatus: 'idle', outputFormat: 'glb', errorMessage: null, faceCount: null, gaussianCount: null, computeBackend: null, renderUrl: null, lightParams: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  },
  {
    id: '9',
    type: 'videoPreview',
    position: { x: 1800, y: 430 },
    data: { label: 'Video Preview', videoUrl: null, videoName: null, modelUrl: null, videoGenerating: false, errorMessage: null, lightParams: null },
  },
  {
    id: 'sn1',
    type: 'stickyNote',
    /* Left edge x=50 with video upload (id 1); stacked above sn2 (~156px note height + gap) */
    position: { x: 50, y: -260 },
    data: { label: 'Sticky Note', text: 'Drag nodes from the library (left) onto the canvas to build your pipeline.' },
  },
  {
    id: 'sn2',
    type: 'stickyNote',
    /* Same y as sn3 so bottoms align; x matches video upload */
    position: { x: 50, y: -88 },
    data: { label: 'Sticky Note', text: 'Notes are saved when you use Save to Library, then open Workflows in the sidebar.' },
  },
  {
    id: 'sn3',
    type: 'stickyNote',
    /* Left edge aligned with Gaussian splat node (id gs1, x=750) */
    position: { x: 750, y: -88 },
    data: {
      label: 'Sticky Note',
      text: 'Gaussian Splat Gen can run directly from extracted frames, or accept a local .ply as a manual source.',
    },
  },
];

export const initialEdges: Edge[] = [
  {
    id: 'e1-2',
    source: '1',
    sourceHandle: 'output',
    target: '2',
    targetHandle: 'input',
    type: 'default',
    animated: false,
    style: { stroke: '#4a6a8a', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e2-gs1',
    source: '2',
    sourceHandle: 'output',
    target: 'gs1',
    targetHandle: 'input',
    type: 'default',
    animated: false,
    style: { stroke: '#6b5f7a', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'egs1-4',
    source: 'gs1',
    sourceHandle: 'splat-output',
    target: '4',
    targetHandle: 'model-input',
    type: 'default',
    animated: false,
    style: { stroke: '#6f5aa8', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e4-10',
    source: '4',
    sourceHandle: 'output',
    target: '10',
    targetHandle: 'obj-input',
    type: 'default',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e10-7',
    source: '10',
    sourceHandle: 'obj-output',
    target: '7',
    targetHandle: 'obj-input',
    type: 'default',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e7-8',
    source: '7',
    sourceHandle: 'obj-output',
    target: '8',
    targetHandle: 'model-input',
    type: 'default',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e7-9',
    source: '7',
    sourceHandle: 'obj-output',
    target: '9',
    targetHandle: 'obj-input',
    type: 'default',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
];

export function createDefaultWorkflowEntry() {
  return {
    id: DEFAULT_WORKFLOW_ID,
    name: DEFAULT_WORKFLOW_NAME,
    nodes: initialNodes,
    edges: initialEdges,
    createdAt: DEFAULT_WORKFLOW_TIMESTAMP,
    updatedAt: DEFAULT_WORKFLOW_TIMESTAMP,
    readonly: true,
    preset: true,
  };
}
