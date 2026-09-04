import type { CompiledWorkflowGraph } from './graph-compiler';

export type WorkflowRunPhase =
  | 'idle'
  | 'validating'
  | 'running'
  | 'waiting-for-user'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed';

export type WorkflowNodeRunPhase =
  | 'blocked'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface WorkflowNodeRunState {
  phase: WorkflowNodeRunPhase;
  attempt: number;
  error: string | null;
  patch: Record<string, unknown>;
}

export interface WorkflowRunState {
  runId: string | null;
  phase: WorkflowRunPhase;
  graph: CompiledWorkflowGraph;
  nodes: Record<string, WorkflowNodeRunState>;
  error: string | null;
}

export function createWorkflowRunState(runId: string, graph: CompiledWorkflowGraph): WorkflowRunState {
  const nodes: Record<string, WorkflowNodeRunState> = {};
  for (const nodeId of graph.executableNodeIds) {
    nodes[nodeId] = {
      phase: 'blocked',
      attempt: 0,
      error: null,
      patch: {},
    };
  }

  return {
    runId,
    phase: 'running',
    graph,
    nodes,
    error: null,
  };
}
