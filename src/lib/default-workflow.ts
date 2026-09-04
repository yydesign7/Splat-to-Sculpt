import type { Edge, Node } from '@xyflow/react';
import { createDefaultNodeData, type WorkflowNodeType } from '@/lib/workflow/node-registry';
import { SAVED_WORKFLOW_SCHEMA_VERSION } from '@/lib/workflow/schema';

export const DEFAULT_WORKFLOW_ID = 'preset_default_workflow';
export const DEFAULT_WORKFLOW_NAME = 'Default Workflow';
export const DEFAULT_WORKFLOW_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function defaultData(type: WorkflowNodeType, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...createDefaultNodeData(type), ...overrides };
}

export const initialNodes: Node[] = [
  // Row 1: Main pipeline
  {
    id: '1',
    type: 'videoUpload',
    position: { x: 50, y: 80 },
    data: defaultData('videoUpload'),
  },
  {
    id: '2',
    type: 'frameExtraction',
    position: { x: 400, y: 80 },
    data: defaultData('frameExtraction'),
  },
  {
    id: 'gs1',
    type: 'gaussianSplat',
    position: { x: 750, y: 80 },
    data: defaultData('gaussianSplat'),
  },
  {
    id: '4',
    type: 'modelGeneration',
    position: { x: 1100, y: 80 },
    data: defaultData('modelGeneration'),
  },
  // Model cleanup: directly below first Mesh Gen (id 4, x=1100)
  {
    id: '10',
    type: 'modelOrganize',
    position: { x: 1100, y: 430 },
    data: defaultData('modelOrganize'),
  },
  // Surface: top-aligned with first Mesh Gen (id 4, y=80)
  {
    id: '7',
    type: 'modelSurface',
    position: { x: 1450, y: 80 },
    data: defaultData('modelSurface'),
  },
  {
    id: '11',
    type: 'comfyVideo',
    position: { x: 1800, y: 80 },
    data: defaultData('comfyVideo'),
  },
  {
    id: '9',
    type: 'videoPreview',
    position: { x: 1800, y: 430 },
    data: defaultData('videoPreview'),
  },
  {
    id: 'sn1',
    type: 'stickyNote',
    /* Left edge x=50 with video upload (id 1); stacked above sn2 (~156px note height + gap) */
    position: { x: 50, y: -260 },
    data: defaultData('stickyNote', { text: 'Drag nodes from the library (left) onto the canvas to build your pipeline.' }),
  },
  {
    id: 'sn2',
    type: 'stickyNote',
    /* Same y as sn3 so bottoms align; x matches video upload */
    position: { x: 50, y: -88 },
    data: defaultData('stickyNote', { text: 'Notes are saved when you use Save to Library, then open Workflows in the sidebar.' }),
  },
  {
    id: 'sn3',
    type: 'stickyNote',
    /* Left edge aligned with Gaussian splat node (id gs1, x=750) */
    position: { x: 750, y: -88 },
    data: defaultData('stickyNote', {
      text: 'Gaussian Splat Gen can run directly from extracted frames, or accept a local .ply as a manual source.',
    }),
  },
];

export const initialEdges: Edge[] = [
  {
    id: 'e1-2',
    source: '1',
    sourceHandle: 'output',
    target: '2',
    targetHandle: 'input',
    type: 'workflow',
    animated: false,
    style: { stroke: '#4a6a8a', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e2-gs1',
    source: '2',
    sourceHandle: 'output',
    target: 'gs1',
    targetHandle: 'input',
    type: 'workflow',
    animated: false,
    style: { stroke: '#6b5f7a', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'egs1-4',
    source: 'gs1',
    sourceHandle: 'splat-output',
    target: '4',
    targetHandle: 'model-input',
    type: 'workflow',
    animated: false,
    style: { stroke: '#6f5aa8', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e4-10',
    source: '4',
    sourceHandle: 'output',
    target: '10',
    targetHandle: 'obj-input',
    type: 'workflow',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e10-7',
    source: '10',
    sourceHandle: 'obj-output',
    target: '7',
    targetHandle: 'obj-input',
    type: 'workflow',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e7-11',
    source: '7',
    sourceHandle: 'obj-output',
    target: '11',
    targetHandle: 'model-input',
    type: 'workflow',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e11-9',
    source: '11',
    sourceHandle: 'video-output',
    target: '9',
    targetHandle: 'video-input',
    type: 'workflow',
    animated: false,
    style: { stroke: '#5f8f74', strokeWidth: 2, strokeDasharray: '5 3' },
  },
];

export function createDefaultWorkflowEntry() {
  return {
    schemaVersion: SAVED_WORKFLOW_SCHEMA_VERSION,
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
