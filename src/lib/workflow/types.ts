import type { Edge, Node } from '@xyflow/react';

export type WorkflowNodeType =
  | 'videoUpload'
  | 'frameExtraction'
  | 'gaussianSplat'
  | 'modelGeneration'
  | 'modelOrganize'
  | 'modelSurface'
  | 'comfyVideo'
  | 'videoPreview'
  | 'stickyNote';

export type WorkflowValueKind =
  | 'video'
  | 'frames'
  | 'pointcloud'
  | 'splat'
  | 'model'
  | 'video-stream';

export type WorkflowExecutionMode =
  | 'manual-source'
  | 'automatic'
  | 'interactive'
  | 'passive-sink'
  | 'annotation';

export type WorkflowNodeCategory = 'input' | 'reconstruction' | 'asset' | 'output' | 'annotation';

export interface WorkflowGraph {
  nodes: Node[];
  edges: Edge[];
}

export interface WorkflowPortDefinition {
  handle: string;
  valueKind: WorkflowValueKind;
  required: boolean;
}

export interface NodeReadiness {
  ready: boolean;
  reason: string;
}

export interface NodeCompletion {
  complete: boolean;
  error: string | null;
}

export interface WorkflowPacket {
  kind: WorkflowValueKind;
  value: unknown;
  metadata: Record<string, unknown>;
}

export interface WorkflowNodeExecutorContext {
  runId: string;
  node: Node;
  signal: AbortSignal;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  reportProgress(patch: Record<string, unknown>): void;
}

export type WorkflowNodeExecutor = (
  context: WorkflowNodeExecutorContext,
) => Promise<Record<string, unknown>>;

export interface WorkflowNodeDefinition {
  type: WorkflowNodeType;
  label: string;
  category: WorkflowNodeCategory;
  icon: string;
  description: string;
  mode: WorkflowExecutionMode;
  inputs: readonly WorkflowPortDefinition[];
  outputs: readonly WorkflowPortDefinition[];
  createDefaultData(): Record<string, unknown>;
  getReadiness(node: Node, graph: WorkflowGraph): NodeReadiness;
  getCompletion(node: Node): NodeCompletion;
  readOutput(node: Node, handle: string): WorkflowPacket | null;
  applyInput(node: Node, handle: string, packet: WorkflowPacket): Record<string, unknown>;
  resetData(node: Node): Record<string, unknown>;
  executor?: WorkflowNodeExecutor;
}
