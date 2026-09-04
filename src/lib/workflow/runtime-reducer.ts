import type { WorkflowRunState } from './runtime-state';

export type WorkflowRunAction =
  | { type: 'RUN_CANCELLING'; runId: string }
  | { type: 'RUN_CANCELLED'; runId: string }
  | { type: 'RUN_FAILED'; runId: string; error: string }
  | { type: 'RUN_COMPLETED'; runId: string }
  | { type: 'NODE_STARTED'; runId: string; nodeId: string }
  | { type: 'NODE_PROGRESS'; runId: string; nodeId: string; patch: Record<string, unknown> }
  | { type: 'NODE_SUCCEEDED'; runId: string; nodeId: string; patch: Record<string, unknown> }
  | { type: 'NODE_FAILED'; runId: string; nodeId: string; error: string };

function predecessorsSucceeded(state: WorkflowRunState, nodeId: string): boolean {
  return (state.graph.incomingEdgesByNodeId[nodeId] ?? []).every(
    (edge) => state.nodes[edge.source]?.phase === 'succeeded',
  );
}

function hasWaitingInteractiveNode(state: WorkflowRunState): boolean {
  return state.graph.executableNodeIds.some((nodeId) => {
    const nodeState = state.nodes[nodeId];
    const definition = state.graph.definitionsByNodeId[nodeId];
    const node = state.graph.nodeById[nodeId];
    if (!nodeState || !definition || !node) return false;
    if (definition.mode !== 'interactive') return false;
    if (nodeState.phase === 'succeeded' || nodeState.phase === 'running' || nodeState.phase === 'failed') return false;
    return predecessorsSucceeded(state, nodeId) && definition.getReadiness(node, state.graph).ready;
  });
}

function terminalNodesSucceeded(state: WorkflowRunState): boolean {
  if (state.graph.terminalNodeIds.length === 0) return false;
  return state.graph.terminalNodeIds.every((nodeId) => state.nodes[nodeId]?.phase === 'succeeded');
}

function refreshRunPhase(state: WorkflowRunState): WorkflowRunState {
  if (state.phase === 'failed' || state.phase === 'cancelled' || state.phase === 'cancelling') return state;
  if (Object.values(state.nodes).some((node) => node.phase === 'failed')) {
    return { ...state, phase: 'failed' };
  }
  if (terminalNodesSucceeded(state)) {
    return { ...state, phase: 'completed' };
  }
  if (hasWaitingInteractiveNode(state)) {
    return { ...state, phase: 'waiting-for-user' };
  }
  return { ...state, phase: 'running' };
}

export function workflowRunReducer(state: WorkflowRunState, action: WorkflowRunAction): WorkflowRunState {
  if (action.runId !== state.runId) return state;

  switch (action.type) {
    case 'RUN_CANCELLING':
      return { ...state, phase: 'cancelling' };
    case 'RUN_CANCELLED':
      return {
        ...state,
        phase: 'cancelled',
        nodes: Object.fromEntries(
          Object.entries(state.nodes).map(([nodeId, nodeState]) => [
            nodeId,
            nodeState.phase === 'running' ? { ...nodeState, phase: 'cancelled' } : nodeState,
          ]),
        ),
      };
    case 'RUN_FAILED':
      return { ...state, phase: 'failed', error: action.error };
    case 'RUN_COMPLETED':
      return { ...state, phase: 'completed' };
    case 'NODE_STARTED': {
      const current = state.nodes[action.nodeId];
      if (!current || current.phase === 'running' || current.phase === 'succeeded') return state;
      return refreshRunPhase({
        ...state,
        phase: 'running',
        nodes: {
          ...state.nodes,
          [action.nodeId]: {
            ...current,
            phase: 'running',
            attempt: current.attempt + 1,
            error: null,
          },
        },
      });
    }
    case 'NODE_PROGRESS': {
      const current = state.nodes[action.nodeId];
      if (!current || current.phase !== 'running') return state;
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [action.nodeId]: {
            ...current,
            patch: { ...current.patch, ...action.patch },
          },
        },
      };
    }
    case 'NODE_SUCCEEDED': {
      const current = state.nodes[action.nodeId];
      if (!current) return state;
      return refreshRunPhase({
        ...state,
        nodes: {
          ...state.nodes,
          [action.nodeId]: {
            ...current,
            phase: 'succeeded',
            error: null,
            patch: { ...current.patch, ...action.patch },
          },
        },
      });
    }
    case 'NODE_FAILED': {
      const current = state.nodes[action.nodeId];
      if (!current) return state;
      return {
        ...state,
        phase: 'failed',
        error: action.error,
        nodes: {
          ...state.nodes,
          [action.nodeId]: {
            ...current,
            phase: 'failed',
            error: action.error,
          },
        },
      };
    }
  }
}
