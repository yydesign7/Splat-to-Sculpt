export type NodeCategory = 'input' | 'process' | 'output' | 'annotation';

export interface NodeTypeConfig {
  type: string;
  label: string;
  category: NodeCategory;
  color: string;
  icon: string;
  description: string;
}

export const NODE_TYPE_CONFIGS: NodeTypeConfig[] = [
  {
    type: 'videoUpload',
    label: 'Video Upload',
    category: 'input',
    color: '#4a6a8a',
    icon: '📹',
    description: 'Upload a video file',
  },
  {
    type: 'frameExtraction',
    label: 'Frame Extraction',
    category: 'process',
    color: '#6b5f7a',
    icon: '🎞️',
    description: 'Extract video frames',
  },
  {
    type: 'pointCloud',
    label: 'Point Cloud Gen',
    category: 'process',
    color: '#4a7a74',
    icon: '☁️',
    description: 'Convert images to point cloud data',
  },
  {
    type: 'material',
    label: 'Material Gen',
    category: 'process',
    color: '#7a6e4a',
    icon: '🎨',
    description: 'Generate texture material data',
  },
  {
    type: 'videoPreview',
    label: 'Video Preview',
    category: 'process',
    color: '#5a7a6a',
    icon: '🎬',
    description: 'Preview and play video',
  },
  {
    type: 'modelSurface',
    label: 'Surface Processing',
    category: 'process',
    color: '#5a7068',
    icon: '🧱',
    description: 'Select model layer and render',
  },
  {
    type: 'modelOrganize',
    label: 'Model Cleanup',
    category: 'process',
    color: '#5a6878',
    icon: '🧹',
    description: 'Preview and clean up model',
  },
  {
    type: 'modelGeneration',
    label: '3DGS Model Gen',
    category: 'output',
    color: '#7a4a55',
    icon: '🔮',
    description: 'Merge point cloud and texture',
  },
  {
    type: 'stickyNote',
    label: 'Sticky Note',
    category: 'annotation',
    color: '#a67c2a',
    icon: '📝',
    description: 'Saved with workflow',
  },
];

export function getNodeConfig(type: string): NodeTypeConfig | undefined {
  return NODE_TYPE_CONFIGS.find((c) => c.type === type);
}

export const NODE_WIDTH = 280;

/** Wider canvas for square video preview in the Video Preview node */
export const VIDEO_PREVIEW_NODE_WIDTH = 340;
