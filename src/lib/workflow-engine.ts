/**
 * Workflow Engine — port mapping, trigger conditions, and data push logic
 * for the 3DGS Studio node-based workflow.
 */

import type { Edge, Node } from '@xyflow/react';
import { inferModelTypeFromUrl } from '@/lib/infer-model-type-from-url';

/* ========== Port Mapping ========== */

/** Maps a source handle id to the output data field on the source node */
const SOURCE_HANDLE_MAP: Record<string, string> = {
  'videoUpload.output': 'videoServerPath',
  'frameExtraction.output': 'frames',
  'pointCloud.ply-output': 'plyUrl',
  'material.texture-output': 'textureUrl',
  'modelOrganize.obj-output': 'outputUrl',
  'modelSurface.obj-output': 'outputModelUrl',
  'modelGeneration.output': 'outputUrl',
};

/**
 * Maps a target handle id to a function that produces the data update for the target node.
 * The function receives (value, sourceNodeType, sourceNodeData) where sourceNodeData
 * allows forwarding additional fields like lightParams.
 */
const TARGET_HANDLE_MAP: Record<string, (value: unknown, sourceNodeType: string, sourceNodeData?: Record<string, unknown>) => Record<string, unknown>> = {
  'frameExtraction.input': (value) => ({ videoServerPath: value as string }),
  'pointCloud.input': (value) => ({ framePaths: value as string[] }),
  'modelGeneration.model-input': (value, sourceNodeType, sourceNodeData) => {
    const isPly = sourceNodeType === 'pointCloud';
    // Infer model type from URL extension for non-PLY sources
    const url = value as string;
    const inferredType = isPly ? 'ply' : inferModelTypeFromUrl(url) || 'obj';
    const result: Record<string, unknown> = { modelUrl: url, inputType: inferredType as 'ply' | 'obj' | 'glb' };
    // Forward lightParams from source node data if present
    if (sourceNodeData?.lightParams) {
      result.lightParams = sourceNodeData.lightParams;
    }
    // Forward layerFiles + layerNames from point cloud node if present
    if (isPly && sourceNodeData?.layerFiles && Array.isArray(sourceNodeData.layerFiles)) {
      result.layerFiles = sourceNodeData.layerFiles;
    }
    if (isPly && sourceNodeData?.layerNames && Array.isArray(sourceNodeData.layerNames)) {
      result.layerNames = sourceNodeData.layerNames;
    }
    return result;
  },
  'modelGeneration.texture': (value) => ({ textureUrl: value as string }),
  'modelOrganize.obj-input': (value, _sourceNodeType, sourceNodeData) => {
    const url = value as string;
    const result: Record<string, unknown> = { modelUrl: url };
    // Forward layerFiles + layerNames from upstream point cloud if present
    if (sourceNodeData?.layerFiles && Array.isArray(sourceNodeData.layerFiles)) {
      result.layerFiles = sourceNodeData.layerFiles;
    }
    if (sourceNodeData?.layerNames && Array.isArray(sourceNodeData.layerNames)) {
      result.layerNames = sourceNodeData.layerNames;
    }
    if (sourceNodeData?.layerGlbUrls && Array.isArray(sourceNodeData.layerGlbUrls)) {
      result.layerGlbUrls = sourceNodeData.layerGlbUrls;
    }
    return result;
  },
  'modelSurface.obj-input': (value, _sourceNodeType, sourceNodeData) => {
    const result: Record<string, unknown> = { modelUrl: value as string };
    // Forward layerFiles + layerNames from upstream point cloud if present
    if (sourceNodeData?.layerFiles && Array.isArray(sourceNodeData.layerFiles)) {
      result.layerFiles = sourceNodeData.layerFiles;
    }
    if (sourceNodeData?.layerNames && Array.isArray(sourceNodeData.layerNames)) {
      result.layerNames = sourceNodeData.layerNames;
    }
    if (sourceNodeData?.layerGlbUrls && Array.isArray(sourceNodeData.layerGlbUrls)) {
      result.layerGlbUrls = sourceNodeData.layerGlbUrls;
    }
    return result;
  },
  'videoPreview.obj-input': (value, _sourceNodeType, sourceNodeData) => {
    const result: Record<string, unknown> = { modelUrl: value as string };
    // Forward lightParams from source node data if present
    if (sourceNodeData?.lightParams) {
      result.lightParams = sourceNodeData.lightParams;
    }
    return result;
  },
};

/* ========== Trigger Conditions ========== */

export interface NodeTriggerInfo {
  canTrigger: boolean;
  reason: string;
  requiredInputs: string[];
  satisfiedInputs: string[];
}

/**
 * Determines if a node is ready to be triggered (all required inputs available).
 * For ModelGenerationNode specifically:
 * - "model-input" (Model handle) is required — must have data
 * - "texture" (PNG handle) is optional — only required if an edge is connected to it
 */
export function getNodeTriggerInfo(
  node: Node,
  edges: Edge[],
  _allNodes: Node[]
): NodeTriggerInfo {
  const d = node.data;
  const nodeId = node.id;
  const incomingEdges = edges.filter((e) => e.target === nodeId);

  switch (node.type) {
    case 'videoUpload': {
      const hasVideo = d.uploadStatus === 'done' || !!d.videoServerPath;
      return {
        canTrigger: !!hasVideo,
        reason: hasVideo ? 'Video uploaded' : 'Waiting for video upload',
        requiredInputs: [],
        satisfiedInputs: hasVideo ? ['video'] : [],
      };
    }
    case 'frameExtraction': {
      const hasVideo = !!d.videoServerPath;
      return {
        canTrigger: hasVideo,
        reason: hasVideo ? 'Video data ready' : 'Waiting for video input',
        requiredInputs: ['video'],
        satisfiedInputs: hasVideo ? ['video'] : [],
      };
    }
    case 'pointCloud': {
      // Point cloud is auto-triggered by frame extraction via data push (status set to 'processing')
      const isActive = d.status === 'processing' || d.status === 'done';
      return {
        canTrigger: isActive,
        reason: isActive ? 'Frame data received' : 'Waiting for frame input',
        requiredInputs: ['frames'],
        satisfiedInputs: isActive ? ['frames'] : [],
      };
    }
    case 'material': {
      // Material needs user text input; no required upstream edge
      const textInput = d.textInput as string | undefined;
      const hasText = !!textInput?.trim();
      return {
        canTrigger: hasText,
        reason: hasText ? 'Prompt entered' : 'Waiting for material description',
        requiredInputs: [],
        satisfiedInputs: hasText ? ['textInput'] : [],
      };
    }
    case 'modelOrganize': {
      const hasInput = !!d.modelUrl;
      const hasIncomingEdge = incomingEdges.length > 0;
      // If no incoming edge, user can upload manually
      if (!hasIncomingEdge) {
        return { canTrigger: false, reason: 'No upstream connection, manual upload required', requiredInputs: [], satisfiedInputs: [] };
      }
      return {
        canTrigger: hasInput,
        reason: hasInput ? 'Model data ready' : 'Waiting for model input',
        requiredInputs: ['model'],
        satisfiedInputs: hasInput ? ['model'] : [],
      };
    }
    case 'modelSurface': {
      const hasModel = !!d.modelUrl;
      const hasIncomingEdge = incomingEdges.length > 0;
      if (!hasIncomingEdge) {
        return { canTrigger: false, reason: 'No upstream connection, manual upload required', requiredInputs: [], satisfiedInputs: [] };
      }
      return {
        canTrigger: hasModel,
        reason: hasModel ? 'Model data ready' : 'Waiting for model input',
        requiredInputs: ['model'],
        satisfiedInputs: hasModel ? ['model'] : [],
      };
    }
    case 'modelGeneration': {
      // model-input is required; texture (PNG) is optional but required IF connected
      const hasModelInput = !!d.modelUrl;
      const textureEdge = incomingEdges.find((e) => e.targetHandle === 'texture');
      const hasTextureInput = !!d.textureUrl;
      const textureRequired = !!textureEdge;

      const requiredInputs = ['model'];
      const satisfiedInputs: string[] = [];

      if (hasModelInput) satisfiedInputs.push('model');
      if (textureRequired) requiredInputs.push('texture');
      if (hasTextureInput && textureRequired) satisfiedInputs.push('texture');

      const canTrigger = hasModelInput && (!textureRequired || hasTextureInput);

      let reason = 'Waiting for input';
      if (canTrigger) {
        reason = textureRequired ? 'Model + PNG data ready' : 'Model data ready';
      } else if (!hasModelInput) {
        reason = 'Waiting for Model input';
      } else if (textureRequired && !hasTextureInput) {
        reason = 'Waiting for PNG material input';
      }

      return { canTrigger, reason, requiredInputs, satisfiedInputs };
    }
    case 'videoPreview': {
      const hasModel = !!d.modelUrl;
      const hasIncomingEdge = incomingEdges.length > 0;
      if (!hasIncomingEdge) {
        return { canTrigger: false, reason: 'No upstream connection, manual upload required', requiredInputs: [], satisfiedInputs: [] };
      }
      return {
        canTrigger: hasModel,
        reason: hasModel ? 'Model data ready' : 'Waiting for model input',
        requiredInputs: ['model'],
        satisfiedInputs: hasModel ? ['model'] : [],
      };
    }
    case 'stickyNote':
      return {
        canTrigger: false,
        reason: 'Annotation only',
        requiredInputs: [],
        satisfiedInputs: [],
      };
    default:
      return { canTrigger: false, reason: 'Unknown node type', requiredInputs: [], satisfiedInputs: [] };
  }
}

/* ========== Data Push ========== */

/**
 * Given a node that just completed processing, compute the data updates
 * that should be pushed to downstream nodes via edges.
 * Returns an array of { targetNodeId, updates } objects.
 */
export function computeDownstreamPushes(
  sourceNode: Node,
  edges: Edge[]
): Array<{ targetNodeId: string; updates: Record<string, unknown> }> {
  const results: Array<{ targetNodeId: string; updates: Record<string, unknown> }> = [];
  const outgoingEdges = edges.filter((e) => e.source === sourceNode.id);

  for (const edge of outgoingEdges) {
    const sourceKey = `${sourceNode.type}.${edge.sourceHandle}`;
    const outputField = SOURCE_HANDLE_MAP[sourceKey];
    if (!outputField) continue;

    const outputValue = sourceNode.data[outputField];
    if (outputValue === undefined || outputValue === null) continue;

    // Find the target node to get its type
    // We need the target node type to look up the target handle map
    const targetKey = edge.targetHandle || '';
    // We construct the key as "targetNodeType.targetHandleId"
    // But we don't have the target node here — we'll use a simpler approach:
    // try all matching target handle map entries
    let updates: Record<string, unknown> | null = null;

    // Try matching by handle id across all known target types
    for (const [mapKey, mapFn] of Object.entries(TARGET_HANDLE_MAP)) {
      const handleId = mapKey.split('.').slice(1).join('.');
      if (handleId === edge.targetHandle) {
        updates = mapFn(outputValue, sourceNode.type || '', sourceNode.data as Record<string, unknown>);
        break;
      }
    }

    if (updates) {
      results.push({ targetNodeId: edge.target, updates });
    }
  }

  return results;
}

/* ========== Node Status Helpers ========== */

/** Returns true when a node has completed its current processing cycle */
export function isNodeDone(node: Node | undefined): boolean {
  if (!node) return false;
  const d = node.data;
  switch (node.type) {
    case 'videoUpload':
      return d.uploadStatus === 'done';
    case 'frameExtraction':
      return d.status === 'done';
    case 'pointCloud':
      return d.status === 'done';
    case 'material':
      return d.status === 'done';
    case 'modelOrganize':
      return d.organizeStatus === 'done';
    case 'modelSurface':
      return !!d.outputModelUrl && !d.blenderProcessing;
    case 'modelGeneration':
      return d.meshStatus === 'done';
    case 'videoPreview':
      return !!d.videoUrl && !d.videoGenerating;
    case 'stickyNote':
      return true;
    default:
      return false;
  }
}

/** Returns true if a node is currently processing */
export function isNodeProcessing(node: Node | undefined): boolean {
  if (!node) return false;
  const d = node.data;
  switch (node.type) {
    case 'videoUpload':
      return d.uploadStatus === 'uploading';
    case 'frameExtraction':
      return d.status === 'extracting';
    case 'pointCloud':
      return d.status === 'processing';
    case 'material':
      return d.status === 'processing';
    case 'modelSurface':
      return !!d.blenderProcessing;
    case 'modelOrganize':
      return d.organizeStatus === 'organizing';
    case 'modelGeneration':
      return d.meshStatus === 'processing';
    case 'videoPreview':
      return !!d.videoGenerating;
    case 'stickyNote':
      return false;
    default:
      return false;
  }
}

/** Returns true if a node has errored */
export function isNodeError(node: Node | undefined): boolean {
  if (!node) return false;
  const d = node.data;
  switch (node.type) {
    case 'videoUpload':
      return d.uploadStatus === 'error';
    case 'frameExtraction':
    case 'pointCloud':
    case 'material':
      return d.status === 'error';
    case 'modelOrganize':
      return d.organizeStatus === 'error';
    case 'modelGeneration':
      return d.meshStatus === 'error';
    case 'modelSurface':
      return !!d.blenderError;
    case 'videoPreview':
      return !!d.errorMessage;
    case 'stickyNote':
      return false;
    default:
      return false;
  }
}

/* ========== Topology ========== */

/**
 * Get the topological execution order of nodes based on edges.
 * Nodes with no incoming edges come first.
 */
export function getTopologicalOrder(nodes: Node[], edges: Edge[]): string[] {
  const inDegree: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};

  for (const node of nodes) {
    inDegree[node.id] = 0;
    adjacency[node.id] = [];
  }

  for (const edge of edges) {
    inDegree[edge.target] = (inDegree[edge.target] || 0) + 1;
    if (!adjacency[edge.source]) adjacency[edge.source] = [];
    adjacency[edge.source].push(edge.target);
  }

  const queue: string[] = [];
  for (const [id, degree] of Object.entries(inDegree)) {
    if (degree === 0) queue.push(id);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    for (const neighbor of adjacency[current] || []) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  return result;
}

/* ========== Edge Color by Handle Type ========== */

/**
 * Maps source handle id → edge color.
 * Each handle type (video, frames, PLY, texture, OBJ, model, video-stream)
 * gets a distinct color so that edges visually indicate the data type they carry.
 */
const HANDLE_EDGE_COLOR_MAP: Record<string, string> = {
  // Video data (purple)
  'output': '#6b5f7a',
  // Frame data (teal)
  'frames-output': '#4a7a74',
  // PLY / point cloud data (teal-green)
  'ply-output': '#5a8a82',
  // Texture / material data (gold)
  'texture-output': '#8a7e5a',
  // OBJ model data (rose)
  'obj-output': '#8a5a66',
  // Video stream data (blue)
  'video-output': '#5a7a8a',
};

const DEFAULT_EDGE_COLOR = '#5a5870';

/**
 * Returns the edge color for a given source handle id.
 * Falls back to DEFAULT_EDGE_COLOR if the handle is not mapped.
 */
export function getEdgeColor(sourceHandle: string | null | undefined): string {
  if (!sourceHandle) return DEFAULT_EDGE_COLOR;
  return HANDLE_EDGE_COLOR_MAP[sourceHandle] ?? DEFAULT_EDGE_COLOR;
}

/**
 * Returns the edge style object for a given source handle id.
 */
export function getEdgeStyle(sourceHandle: string | null | undefined): { stroke: string; strokeWidth: number; strokeDasharray: string } {
  return {
    stroke: getEdgeColor(sourceHandle),
    strokeWidth: 2,
    strokeDasharray: '5 3',
  };
}
