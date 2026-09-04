import type { Edge, Node } from '@xyflow/react';
import { sanitizeLoadedWorkflowGraph } from '@/lib/workflow-load-sanitizer';
import {
  SAVED_WORKFLOW_SCHEMA_VERSION,
  SavedWorkflowGraphSchema,
  type SavedWorkflowGraph,
} from './schema';
import { createDefaultNodeData, isWorkflowNodeType } from './node-registry';

export { SAVED_WORKFLOW_SCHEMA_VERSION } from './schema';

function normalizeNodeForPersistence(node: Node): Node | null {
  if (!isWorkflowNodeType(node.type)) return null;

  const defaults = createDefaultNodeData(node.type);
  const sourceData = node.data as Record<string, unknown>;
  const data: Record<string, unknown> = { ...defaults };

  if (node.type === 'stickyNote') {
    data.label = typeof sourceData.label === 'string' ? sourceData.label : defaults.label;
    data.text = typeof sourceData.text === 'string' ? sourceData.text : defaults.text;
  }

  return {
    ...node,
    type: node.type,
    data,
  };
}

export function migrateSavedWorkflow(input: unknown): SavedWorkflowGraph {
  const parsed = SavedWorkflowGraphSchema.parse(input);
  const nodes = parsed.nodes as Node[];
  const edges = parsed.edges as Edge[];
  const sanitized = sanitizeLoadedWorkflowGraph(nodes, edges);
  const normalizedNodes = sanitized.nodes
    .map((node) => normalizeNodeForPersistence(node))
    .filter((node): node is Node => node !== null);
  const retainedNodeIds = new Set(normalizedNodes.map((node) => node.id));
  const normalizedEdges = sanitized.edges.filter(
    (edge) => retainedNodeIds.has(edge.source) && retainedNodeIds.has(edge.target),
  );

  return {
    ...parsed,
    schemaVersion: SAVED_WORKFLOW_SCHEMA_VERSION,
    nodes: normalizedNodes,
    edges: normalizedEdges,
  };
}
