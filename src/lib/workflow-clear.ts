export type ClearableNode = {
  id: string;
  type?: string;
  selected?: boolean;
  dragging?: boolean;
  data: unknown;
};

export type ClearableEdge = {
  id: string;
  source: string;
  target: string;
};

type ClearWorkflowOptions<N extends ClearableNode, E extends ClearableEdge> = {
  nodeIdFactory?: (node: N, index: number) => string;
  edgeIdFactory?: (edge: E, index: number) => string;
};

function makeRuntimeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function buildClearedWorkflowGraph<N extends ClearableNode, E extends ClearableEdge>(
  nodes: N[],
  edges: E[],
  clearDataForNode: (node: N) => Record<string, unknown>,
  options: ClearWorkflowOptions<N, E> = {},
): { nodes: N[]; edges: E[] } {
  const nodeIdByOldId = new Map<string, string>();

  const nextNodes = nodes.map((node, index) => {
    const nextId = options.nodeIdFactory?.(node, index) ?? makeRuntimeId(node.type || 'node');
    nodeIdByOldId.set(node.id, nextId);
    return {
      ...node,
      id: nextId,
      selected: false,
      dragging: false,
      data: clearDataForNode(node),
    };
  });

  const nextEdges = edges.map((edge, index) => ({
    ...edge,
    id: options.edgeIdFactory?.(edge, index) ?? makeRuntimeId('edge'),
    source: nodeIdByOldId.get(edge.source) ?? edge.source,
    target: nodeIdByOldId.get(edge.target) ?? edge.target,
    selected: false,
  }));

  return { nodes: nextNodes, edges: nextEdges };
}
