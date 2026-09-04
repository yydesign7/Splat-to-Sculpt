import type { CompiledWorkflowGraph } from './graph-compiler';
import type { WorkflowRunState } from './runtime-state';

function predecessorsSucceeded(
  graph: CompiledWorkflowGraph,
  state: WorkflowRunState,
  nodeId: string,
): boolean {
  return (graph.incomingEdgesByNodeId[nodeId] ?? []).every(
    (edge) => state.nodes[edge.source]?.phase === 'succeeded',
  );
}

export function findReadyNodeIds(graph: CompiledWorkflowGraph, state: WorkflowRunState): string[] {
  if (state.phase === 'failed' || state.phase === 'cancelled' || state.phase === 'cancelling') return [];

  return graph.topologicalOrder.filter((nodeId) => {
    const nodeState = state.nodes[nodeId];
    const definition = graph.definitionsByNodeId[nodeId];
    const node = graph.nodeById[nodeId];
    if (!nodeState || !definition || !node) return false;
    if (definition.mode !== 'automatic') return false;
    if (nodeState.phase !== 'blocked' && nodeState.phase !== 'ready') return false;
    if (!predecessorsSucceeded(graph, state, nodeId)) return false;
    return definition.getReadiness(node, graph).ready;
  });
}

export function isRunComplete(graph: CompiledWorkflowGraph, state: WorkflowRunState): boolean {
  if (graph.terminalNodeIds.length === 0) return false;
  return graph.terminalNodeIds.every((nodeId) => state.nodes[nodeId]?.phase === 'succeeded');
}
