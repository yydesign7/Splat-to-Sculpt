import type { Node } from '@xyflow/react';
import { inferModelTypeFromUrl } from '@/lib/infer-model-type-from-url';
import { createNodeDefaultData } from './node-data';
import type {
  NodeCompletion,
  NodeReadiness,
  WorkflowGraph,
  WorkflowNodeDefinition,
  WorkflowNodeType,
  WorkflowPacket,
  WorkflowValueKind,
} from './types';

export type { WorkflowNodeType } from './types';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function hasIncomingEdge(node: Node, graph: WorkflowGraph): boolean {
  return graph.edges.some((edge) => edge.target === node.id);
}

function copyMetadata(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of keys) {
    const value = data[key];
    if (value !== undefined && value !== null) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function outputPacket(
  node: Node,
  handle: string,
  expectedHandle: string,
  field: string,
  kind: WorkflowValueKind,
  metadataKeys: string[] = [],
): WorkflowPacket | null {
  if (handle !== expectedHandle) return null;
  const data = node.data as Record<string, unknown>;
  const value = data[field];
  if (value === undefined || value === null) return null;
  return { kind, value, metadata: copyMetadata(data, metadataKeys) };
}

function modelPacket(node: Node, handle: string, field: string): WorkflowPacket | null {
  return outputPacket(node, handle, 'obj-output', field, 'model', [
    'layerNames',
    'layerGlbUrls',
    'lightParams',
  ]);
}

function resetWithPreservedNote(node: Node): Record<string, unknown> {
  const defaults = createNodeDefaultData(node.type as WorkflowNodeType);
  if (node.type === 'stickyNote' && typeof node.data?.text === 'string') {
    defaults.text = node.data.text;
  }
  return defaults;
}

const noOutput = () => null;
const noInput = () => ({});

export const WORKFLOW_NODE_REGISTRY = {
  videoUpload: {
    type: 'videoUpload',
    label: 'Video Upload',
    category: 'input',
    icon: '📹',
    description: 'upload video and set frame count',
    mode: 'manual-source',
    inputs: [],
    outputs: [{ handle: 'output', valueKind: 'video', required: true }],
    createDefaultData: () => createNodeDefaultData('videoUpload'),
    getReadiness: (node) => {
      const hasVideo = node.data.uploadStatus === 'done' || isNonEmptyString(node.data.videoServerPath);
      return { ready: hasVideo, reason: hasVideo ? 'Video uploaded' : 'Waiting for video upload' };
    },
    getCompletion: (node) => ({
      complete: node.data.uploadStatus === 'done' || isNonEmptyString(node.data.videoServerPath),
      error: node.data.uploadStatus === 'error' ? String(node.data.uploadError ?? 'Video upload failed') : null,
    }),
    readOutput: (node, handle) => outputPacket(node, handle, 'output', 'videoServerPath', 'video', ['targetFrameCount']),
    applyInput: noInput,
    resetData: resetWithPreservedNote,
  },
  frameExtraction: {
    type: 'frameExtraction',
    label: 'Frame Extraction',
    category: 'reconstruction',
    icon: '🎞️',
    description: 'video -> image',
    mode: 'automatic',
    inputs: [{ handle: 'input', valueKind: 'video', required: true }],
    outputs: [{ handle: 'output', valueKind: 'frames', required: true }],
    createDefaultData: () => createNodeDefaultData('frameExtraction'),
    getReadiness: (node) => {
      const ready = isNonEmptyString(node.data.videoServerPath);
      return { ready, reason: ready ? 'Video data ready' : 'Waiting for video input' };
    },
    getCompletion: (node) => ({
      complete: node.data.status === 'done',
      error: node.data.status === 'error' ? String(node.data.errorMessage ?? 'Frame extraction failed') : null,
    }),
    readOutput: (node, handle) => outputPacket(node, handle, 'output', 'frames', 'frames'),
    applyInput: (_node, _handle, packet) => {
      const updates: Record<string, unknown> = { videoServerPath: packet.value };
      if (typeof packet.metadata.targetFrameCount === 'number') {
        updates.targetFrameCount = packet.metadata.targetFrameCount;
      }
      return updates;
    },
    resetData: resetWithPreservedNote,
  },
  gaussianSplat: {
    type: 'gaussianSplat',
    label: 'Gaussian Splat Gen',
    category: 'reconstruction',
    icon: '✦',
    description: 'image/PLY -> splat PLY',
    mode: 'automatic',
    inputs: [
      { handle: 'input', valueKind: 'frames', required: false },
      { handle: 'ply-input', valueKind: 'pointcloud', required: false },
    ],
    outputs: [
      { handle: 'mesh-output', valueKind: 'pointcloud', required: false },
      { handle: 'splat-output', valueKind: 'splat', required: false },
    ],
    createDefaultData: () => createNodeDefaultData('gaussianSplat'),
    getReadiness: (node) => {
      const hasFrames = Array.isArray(node.data.framePaths) && node.data.framePaths.length > 0;
      const hasPly = isNonEmptyString(node.data.sourcePlyUrl);
      return {
        ready: hasFrames || hasPly,
        reason: hasFrames
          ? 'Frame data ready'
          : hasPly
            ? 'Point cloud data ready'
            : 'Waiting for frames or point cloud input',
      };
    },
    getCompletion: (node) => ({
      complete:
        node.data.status === 'done' &&
        (isNonEmptyString(node.data.splatUrl) || isNonEmptyString(node.data.sourcePlyUrl)),
      error: node.data.status === 'error' ? String(node.data.errorMessage ?? 'Gaussian Splat failed') : null,
    }),
    readOutput: (node, handle) => {
      if (handle === 'splat-output') {
        return outputPacket(node, handle, 'splat-output', 'splatUrl', 'splat', [
          'gaussianCount',
          'computeBackend',
        ]);
      }
      if (handle === 'mesh-output') {
        return outputPacket(node, handle, 'mesh-output', 'sourcePlyUrl', 'pointcloud', [
          'gaussianCount',
          'computeBackend',
        ]);
      }
      return null;
    },
    applyInput: (_node, handle, packet) => {
      if (handle === 'input') return { framePaths: packet.value };
      if (handle === 'ply-input') return { sourcePlyUrl: packet.value };
      return {};
    },
    resetData: resetWithPreservedNote,
  },
  modelGeneration: {
    type: 'modelGeneration',
    label: 'Mesh Gen',
    category: 'asset',
    icon: '▣',
    description: 'splat/PLY/OBJ/GLB -> GLB/OBJ/PLY',
    mode: 'automatic',
    inputs: [{ handle: 'model-input', valueKind: 'model', required: true }],
    outputs: [{ handle: 'output', valueKind: 'model', required: true }],
    createDefaultData: () => createNodeDefaultData('modelGeneration'),
    getReadiness: (node) => {
      const ready = isNonEmptyString(node.data.modelUrl);
      return { ready, reason: ready ? 'Model data ready' : 'Waiting for Model input' };
    },
    getCompletion: (node) => ({
      complete: node.data.meshStatus === 'done',
      error: node.data.meshStatus === 'error' ? String(node.data.errorMessage ?? 'Mesh generation failed') : null,
    }),
    readOutput: (node, handle) =>
      outputPacket(node, handle, 'output', 'outputUrl', 'model', [
        'layerNames',
        'layerGlbUrls',
        'lightParams',
        'gaussianCount',
        'computeBackend',
      ]),
    applyInput: (_node, _handle, packet) => {
      const url = String(packet.value);
      const metadata = packet.metadata;
      const fromSplat = packet.kind === 'splat';
      const fromPointcloud = packet.kind === 'pointcloud';
      const updates: Record<string, unknown> = {
        modelUrl: url,
        inputType: fromSplat ? 'splat' : fromPointcloud ? 'ply' : inferModelTypeFromUrl(url) || 'obj',
      };
      for (const key of ['lightParams', 'layerNames', 'layerGlbUrls', 'gaussianCount', 'computeBackend']) {
        if (metadata[key] !== undefined) updates[key] = metadata[key];
      }
      return updates;
    },
    resetData: resetWithPreservedNote,
  },
  modelOrganize: {
    type: 'modelOrganize',
    label: 'Model Cleanup',
    category: 'asset',
    icon: '🧹',
    description: 'model -> model',
    mode: 'automatic',
    inputs: [{ handle: 'obj-input', valueKind: 'model', required: true }],
    outputs: [{ handle: 'obj-output', valueKind: 'model', required: true }],
    createDefaultData: () => createNodeDefaultData('modelOrganize'),
    getReadiness: (node, graph) => {
      if (!hasIncomingEdge(node, graph)) {
        return { ready: false, reason: 'No upstream connection, manual upload required' };
      }
      const ready = isNonEmptyString(node.data.modelUrl);
      return { ready, reason: ready ? 'Model data ready' : 'Waiting for model input' };
    },
    getCompletion: (node) => ({
      complete: node.data.organizeStatus === 'done',
      error: node.data.organizeStatus === 'error' ? String(node.data.errorMessage ?? 'Model cleanup failed') : null,
    }),
    readOutput: (node, handle) => modelPacket(node, handle, 'outputUrl'),
    applyInput: (_node, _handle, packet) => ({
      modelUrl: packet.value,
      ...copyMetadata(packet.metadata, ['layerNames', 'layerGlbUrls']),
    }),
    resetData: resetWithPreservedNote,
  },
  modelSurface: {
    type: 'modelSurface',
    label: 'Surface Processing',
    category: 'asset',
    icon: '🧱',
    description: 'model -> model',
    mode: 'interactive',
    inputs: [{ handle: 'obj-input', valueKind: 'model', required: true }],
    outputs: [{ handle: 'obj-output', valueKind: 'model', required: true }],
    createDefaultData: () => createNodeDefaultData('modelSurface'),
    getReadiness: (node, graph) => {
      if (!hasIncomingEdge(node, graph)) {
        return { ready: false, reason: 'No upstream connection, manual upload required' };
      }
      const ready = isNonEmptyString(node.data.modelUrl);
      return { ready, reason: ready ? 'Model data ready' : 'Waiting for model input' };
    },
    getCompletion: (node) => ({
      complete: isNonEmptyString(node.data.outputModelUrl) && !node.data.blenderProcessing,
      error: node.data.blenderError ? String(node.data.blenderError) : null,
    }),
    readOutput: (node, handle) =>
      outputPacket(node, handle, 'obj-output', 'outputModelUrl', 'model', [
        'layerNames',
        'layerGlbUrls',
        'lightParams',
      ]),
    applyInput: (_node, _handle, packet) => ({
      modelUrl: packet.value,
      ...copyMetadata(packet.metadata, ['layerNames', 'layerGlbUrls']),
    }),
    resetData: resetWithPreservedNote,
  },
  comfyVideo: {
    type: 'comfyVideo',
    label: 'ComfyUI Video Gen',
    category: 'output',
    icon: '▶',
    description: 'model -> ComfyUI video',
    mode: 'automatic',
    inputs: [{ handle: 'model-input', valueKind: 'model', required: true }],
    outputs: [{ handle: 'video-output', valueKind: 'video-stream', required: true }],
    createDefaultData: () => createNodeDefaultData('comfyVideo'),
    getReadiness: (node, graph) => {
      if (!hasIncomingEdge(node, graph)) {
        return { ready: false, reason: 'No upstream connection, manual upload required' };
      }
      const ready = isNonEmptyString(node.data.modelUrl);
      return { ready, reason: ready ? 'Model data ready' : 'Waiting for model input' };
    },
    getCompletion: (node) => ({
      complete: node.data.comfyStatus === 'done' && isNonEmptyString(node.data.videoUrl),
      error: node.data.comfyStatus === 'error' ? String(node.data.errorMessage ?? 'ComfyUI video failed') : null,
    }),
    readOutput: (node, handle) => outputPacket(node, handle, 'video-output', 'videoUrl', 'video-stream', ['videoName']),
    applyInput: (_node, _handle, packet) => ({
      modelUrl: packet.value,
      ...copyMetadata(packet.metadata, ['lightParams']),
    }),
    resetData: resetWithPreservedNote,
  },
  videoPreview: {
    type: 'videoPreview',
    label: 'Video Preview',
    category: 'output',
    icon: '🎬',
    description: 'model -> video',
    mode: 'passive-sink',
    inputs: [
      { handle: 'obj-input', valueKind: 'model', required: false },
      { handle: 'video-input', valueKind: 'video-stream', required: false },
    ],
    outputs: [],
    createDefaultData: () => createNodeDefaultData('videoPreview'),
    getReadiness: (node, graph) => {
      if (!hasIncomingEdge(node, graph)) {
        return { ready: false, reason: 'No upstream connection, manual upload required' };
      }
      const hasModel = isNonEmptyString(node.data.modelUrl);
      const hasVideo = isNonEmptyString(node.data.videoUrl);
      return {
        ready: hasModel || hasVideo,
        reason: hasVideo ? 'Video data ready' : hasModel ? 'Model data ready' : 'Waiting for video or model input',
      };
    },
    getCompletion: (node) => ({
      complete: isNonEmptyString(node.data.videoUrl) && !node.data.videoGenerating,
      error: node.data.errorMessage ? String(node.data.errorMessage) : null,
    }),
    readOutput: noOutput,
    applyInput: (_node, handle, packet) => {
      if (handle === 'video-input') {
        return {
          videoUrl: packet.value,
          ...copyMetadata(packet.metadata, ['videoName']),
        };
      }
      if (handle === 'obj-input') {
        return {
          modelUrl: packet.value,
          ...copyMetadata(packet.metadata, ['lightParams']),
        };
      }
      return {};
    },
    resetData: resetWithPreservedNote,
  },
  stickyNote: {
    type: 'stickyNote',
    label: 'Sticky Note',
    category: 'annotation',
    icon: '📝',
    description: 'record your idea',
    mode: 'annotation',
    inputs: [],
    outputs: [],
    createDefaultData: () => createNodeDefaultData('stickyNote'),
    getReadiness: (): NodeReadiness => ({ ready: false, reason: 'Annotation only' }),
    getCompletion: (): NodeCompletion => ({ complete: true, error: null }),
    readOutput: noOutput,
    applyInput: noInput,
    resetData: resetWithPreservedNote,
  },
} satisfies Record<WorkflowNodeType, WorkflowNodeDefinition>;

export function isWorkflowNodeType(type: string | undefined): type is WorkflowNodeType {
  return type !== undefined && Object.hasOwn(WORKFLOW_NODE_REGISTRY, type);
}

export function getWorkflowNodeDefinition(type: string | undefined): WorkflowNodeDefinition | null {
  return isWorkflowNodeType(type) ? WORKFLOW_NODE_REGISTRY[type] : null;
}

export function createDefaultNodeData(type: WorkflowNodeType): Record<string, unknown> {
  return WORKFLOW_NODE_REGISTRY[type].createDefaultData();
}

export function packetValueIsStringArray(packet: WorkflowPacket): boolean {
  return isStringArray(packet.value);
}
