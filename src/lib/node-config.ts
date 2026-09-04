import { WORKFLOW_NODE_REGISTRY } from '@/lib/workflow/node-registry';
import type { WorkflowNodeCategory } from '@/lib/workflow/types';

export type NodeCategory = WorkflowNodeCategory;

export interface NodeVisualTheme {
  accent: string;
  accentSoft: string;
  accentMuted: string;
  text: string;
  border: string;
}

export interface NodeTypeConfig {
  type: string;
  label: string;
  category: NodeCategory;
  color: string;
  icon: string;
  description: string;
}

export const NODE_CATEGORY_THEMES: Record<NodeCategory, NodeVisualTheme> = {
  input: {
    accent: '#4f7fa8',
    accentSoft: 'rgba(79, 127, 168, 0.18)',
    accentMuted: 'rgba(79, 127, 168, 0.34)',
    text: '#b8d8f5',
    border: 'rgba(79, 127, 168, 0.55)',
  },
  reconstruction: {
    accent: '#7b68c8',
    accentSoft: 'rgba(123, 104, 200, 0.18)',
    accentMuted: 'rgba(123, 104, 200, 0.34)',
    text: '#d2c8ff',
    border: 'rgba(123, 104, 200, 0.55)',
  },
  asset: {
    accent: '#9a6674',
    accentSoft: 'rgba(154, 102, 116, 0.18)',
    accentMuted: 'rgba(154, 102, 116, 0.34)',
    text: '#f0bdca',
    border: 'rgba(154, 102, 116, 0.55)',
  },
  output: {
    accent: '#5f8f74',
    accentSoft: 'rgba(95, 143, 116, 0.18)',
    accentMuted: 'rgba(95, 143, 116, 0.34)',
    text: '#bde6ce',
    border: 'rgba(95, 143, 116, 0.55)',
  },
  annotation: {
    accent: '#a88945',
    accentSoft: 'rgba(168, 137, 69, 0.18)',
    accentMuted: 'rgba(168, 137, 69, 0.34)',
    text: '#ead69b',
    border: 'rgba(168, 137, 69, 0.55)',
  },
};

export const NODE_TYPE_CONFIGS: NodeTypeConfig[] = Object.values(WORKFLOW_NODE_REGISTRY).map((definition) => ({
  type: definition.type,
  label: definition.label,
  category: definition.category,
  color: NODE_CATEGORY_THEMES[definition.category].accent,
  icon: definition.icon,
  description: definition.description,
}));

export function getNodeConfig(type: string): NodeTypeConfig | undefined {
  return NODE_TYPE_CONFIGS.find((c) => c.type === type);
}

export function getNodeVisualTheme(type: string): NodeVisualTheme {
  const category = getNodeConfig(type)?.category ?? 'asset';
  return NODE_CATEGORY_THEMES[category];
}

export const NODE_WIDTH = 280;

/** Wider canvas for square video preview in the Video Preview node */
export const VIDEO_PREVIEW_NODE_WIDTH = 340;
