import type { Edge, Node } from '@xyflow/react';
import {
  compileWorkflowGraph,
  type CompiledWorkflowGraph,
  type CompileWorkflowResult,
  type WorkflowDiagnostic,
} from './graph-compiler';
import { createWorkflowRunState, type WorkflowRunState } from './runtime-state';
import { workflowRunReducer } from './runtime-reducer';
import { findReadyNodeIds, isRunComplete } from './scheduler';
import type { WorkflowNodeExecutor, WorkflowNodeExecutorContext, WorkflowNodeType } from './types';

export type WorkflowNodeUpdater = (nodes: Node[]) => Node[];

export interface WorkflowRunnerHost {
  getNodes(): Node[];
  getEdges(): Edge[];
  setNodes(updater: WorkflowNodeUpdater): void;
  apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  ephemeralSessionId?: string | null;
  executors?: Partial<Record<WorkflowNodeType, WorkflowNodeExecutor>>;
  onStateChange?: (state: WorkflowRunState | null) => void;
  onDiagnostics?: (diagnostics: WorkflowDiagnostic[]) => void;
  cancelTasks?: () => Promise<void>;
}

export interface WorkflowRunnerSnapshot {
  phase: WorkflowRunState['phase'];
  runId: string | null;
  diagnostics: WorkflowDiagnostic[];
  progress: { done: number; total: number };
  error: string | null;
}

export interface WorkflowRunner {
  run(): Promise<void>;
  stop(): void;
  runSingleNode(nodeId: string): Promise<void>;
  getSnapshot(): WorkflowRunnerSnapshot;
  getState(): WorkflowRunState | null;
}

function randomRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isActivePhase(phase: WorkflowRunState['phase']): boolean {
  return phase === 'running' || phase === 'waiting-for-user';
}

function compileOrReport(host: WorkflowRunnerHost): CompileWorkflowResult {
  const compiled = compileWorkflowGraph(host.getNodes(), host.getEdges());
  if (!compiled.ok) {
    host.onDiagnostics?.(compiled.diagnostics);
    return compiled;
  }
  host.onDiagnostics?.([]);
  return compiled;
}

function replaceNodeData(nodes: Node[], nodeId: string, patch: Record<string, unknown>): Node[] {
  return nodes.map((node) =>
    node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node,
  );
}

export function createWorkflowRunner(host: WorkflowRunnerHost): WorkflowRunner {
  let state: WorkflowRunState | null = null;
  let diagnostics: WorkflowDiagnostic[] = [];
  let activeRunId: string | null = null;
  let graph: CompiledWorkflowGraph | null = null;
  let propagatedEdgeIds = new Set<string>();
  const controllers = new Map<string, AbortController>();

  function publish(nextState: WorkflowRunState): void {
    state = nextState;
    host.onStateChange?.(state);
  }

  function dispatch(action: Parameters<typeof workflowRunReducer>[1]): void {
    if (!state) return;
    publish(workflowRunReducer(state, action));
  }

  function refreshGraph(): void {
    const compiled = compileWorkflowGraph(host.getNodes(), host.getEdges());
    if (compiled.ok) {
      graph = compiled.graph;
      if (state) {
        state = { ...state, graph };
        host.onStateChange?.(state);
      }
    }
  }

  function applyNodePatch(runId: string, nodeId: string, patch: Record<string, unknown>): void {
    if (runId !== activeRunId) return;
    host.setNodes((nodes) => replaceNodeData(nodes, nodeId, patch));
    refreshGraph();
    dispatch({ type: 'RUN_REFRESH', runId });
  }

  function markAlreadyCompleteNodes(runId: string): void {
    if (!graph || !state) return;
    for (const nodeId of graph.topologicalOrder) {
      const node = graph.nodeById[nodeId];
      const definition = graph.definitionsByNodeId[nodeId];
      const nodeState = state.nodes[nodeId];
      if (!node || !definition || !nodeState || nodeState.phase === 'succeeded') continue;
      if (definition.mode !== 'manual-source' && definition.mode !== 'passive-sink') continue;
      const completion = definition.getCompletion(node);
      if (completion.complete) {
        dispatch({ type: 'NODE_SUCCEEDED', runId, nodeId, patch: {} });
        propagateNodeOutputs(runId, nodeId);
      }
    }
  }

  function propagateNodeOutputs(runId: string, nodeId: string): void {
    if (!graph || runId !== activeRunId) return;
    const sourceNode = graph.nodeById[nodeId];
    const sourceDefinition = graph.definitionsByNodeId[nodeId];
    if (!sourceNode || !sourceDefinition) return;

    for (const edge of graph.outgoingEdgesByNodeId[nodeId] ?? []) {
      if (propagatedEdgeIds.has(edge.id)) continue;
      const targetNode = graph.nodeById[edge.target];
      const targetDefinition = graph.definitionsByNodeId[edge.target];
      if (!targetNode || !targetDefinition) continue;
      const packet = sourceDefinition.readOutput(sourceNode, edge.sourceHandle ?? '');
      if (!packet) continue;
      const updates = targetDefinition.applyInput(targetNode, edge.targetHandle ?? '', packet);
      if (Object.keys(updates).length === 0) continue;
      propagatedEdgeIds.add(edge.id);
      applyNodePatch(runId, edge.target, updates);
    }
  }

  async function startNode(runId: string, nodeId: string): Promise<void> {
    if (!graph || !state || runId !== activeRunId) return;
    const node = graph.nodeById[nodeId];
    const definition = graph.definitionsByNodeId[nodeId];
    if (!node || !definition) return;
    const executor = host.executors?.[definition.type] ?? definition.executor;
    if (!executor) {
      dispatch({ type: 'NODE_FAILED', runId, nodeId, error: `No executor registered for ${definition.type}` });
      return;
    }

    const controller = new AbortController();
    controllers.set(nodeId, controller);
    dispatch({ type: 'NODE_STARTED', runId, nodeId });
    try {
      const context: WorkflowNodeExecutorContext = {
        runId,
        ephemeralSessionId: host.ephemeralSessionId ?? undefined,
        node,
        signal: controller.signal,
        apiFetch: host.apiFetch,
        reportProgress: (patch) => {
          if (runId !== activeRunId) return;
          applyNodePatch(runId, nodeId, patch);
          dispatch({ type: 'NODE_PROGRESS', runId, nodeId, patch });
        },
      };
      const patch = await executor(context);
      if (runId !== activeRunId || controller.signal.aborted) return;
      applyNodePatch(runId, nodeId, patch);
      dispatch({ type: 'NODE_SUCCEEDED', runId, nodeId, patch });
      propagateNodeOutputs(runId, nodeId);
    } catch (error) {
      if (runId !== activeRunId || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Workflow node failed';
      applyNodePatch(runId, nodeId, { errorMessage: message });
      dispatch({ type: 'NODE_FAILED', runId, nodeId, error: message });
    } finally {
      if (controllers.get(nodeId) === controller) controllers.delete(nodeId);
    }
  }

  async function drainReadyNodes(runId: string): Promise<void> {
    while (graph && state && runId === activeRunId && isActivePhase(state.phase)) {
      markAlreadyCompleteNodes(runId);
      if (!graph || !state) break;
      const readyNodeIds = findReadyNodeIds(graph, state);
      if (readyNodeIds.length === 0) {
        if (isRunComplete(graph, state)) dispatch({ type: 'RUN_COMPLETED', runId });
        break;
      }
      await Promise.allSettled(readyNodeIds.map((nodeId) => startNode(runId, nodeId)));
    }
  }

  async function run(): Promise<void> {
    const compiled = compileOrReport(host);
    if (!compiled.ok) {
      diagnostics = compiled.diagnostics;
      return;
    }
    diagnostics = [];
    graph = compiled.graph;
    propagatedEdgeIds = new Set();
    controllers.clear();
    const runId = randomRunId();
    activeRunId = runId;
    publish(createWorkflowRunState(runId, graph));
    await drainReadyNodes(runId);
  }

  function stop(): void {
    const runId = activeRunId;
    if (!runId || !state) return;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    dispatch({ type: 'RUN_CANCELLING', runId });
    activeRunId = null;
    void host.cancelTasks?.().finally(() => {
      if (state?.runId === runId) {
        publish(workflowRunReducer({ ...state }, { type: 'RUN_CANCELLED', runId }));
      }
    });
    if (state?.runId === runId) {
      publish(workflowRunReducer(state, { type: 'RUN_CANCELLED', runId }));
    }
  }

  async function runSingleNode(nodeId: string): Promise<void> {
    const compiled = compileOrReport(host);
    if (!compiled.ok) {
      diagnostics = compiled.diagnostics;
      return;
    }
    diagnostics = [];
    graph = compiled.graph;
    const runId = activeRunId ?? randomRunId();
    activeRunId = runId;
    if (!state || state.runId !== runId) {
      publish(createWorkflowRunState(runId, graph));
    }
    await startNode(runId, nodeId);
    await drainReadyNodes(runId);
  }

  function getSnapshot(): WorkflowRunnerSnapshot {
    const current = state;
    const total = current ? Object.keys(current.nodes).length : 0;
    const done = current
      ? Object.values(current.nodes).filter((node) => node.phase === 'succeeded').length
      : 0;
    return {
      phase: current?.phase ?? 'idle',
      runId: current?.runId ?? null,
      diagnostics,
      progress: { done, total },
      error: current?.error ?? diagnostics[0]?.message ?? null,
    };
  }

  return {
    run,
    stop,
    runSingleNode,
    getSnapshot,
    getState: () => state,
  };
}
