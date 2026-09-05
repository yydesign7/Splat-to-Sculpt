'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import {
  createWorkflowRunner,
  type WorkflowRunnerSnapshot,
  type WorkflowNodeUpdater,
} from '@/lib/workflow/runner';

const IDLE_SNAPSHOT: WorkflowRunnerSnapshot = {
  phase: 'idle',
  runId: null,
  diagnostics: [],
  progress: { done: 0, total: 0 },
  error: null,
};

export function useWorkflowRunner({
  nodes,
  edges,
  setNodes,
  apiFetch,
  ephemeralSessionId,
}: {
  nodes: Node[];
  edges: Edge[];
  setNodes: (updater: WorkflowNodeUpdater) => void;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  ephemeralSessionId: string | null;
}) {
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const [snapshot, setSnapshot] = useState<WorkflowRunnerSnapshot>(IDLE_SNAPSHOT);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  const runner = useMemo(
    () => {
      // The runner stores callback functions; they read refs later from event handlers,
      // not during React render.
      // eslint-disable-next-line react-hooks/refs
      const runnerInstance = createWorkflowRunner({
        getNodes: () => nodesRef.current,
        getEdges: () => edgesRef.current,
        setNodes,
        apiFetch,
        ephemeralSessionId,
        onStateChange: () => {
          setSnapshot(runnerInstance.getSnapshot());
        },
        onDiagnostics: (diagnostics) => {
          setSnapshot((current) => ({
            ...current,
            diagnostics,
            error: diagnostics[0]?.message ?? null,
          }));
        },
        cancelTasks: async () => {
          await apiFetch('/api/cancel-workflow-tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
        },
      });
      return runnerInstance;
    },
    [apiFetch, ephemeralSessionId, setNodes],
  );

  useEffect(
    () => () => {
      runner.stop();
    },
    [runner],
  );

  const run = useCallback(() => {
    void runner.run();
  }, [runner]);

  const stop = useCallback(() => {
    runner.stop();
  }, [runner]);

  const runSingleNode = useCallback((nodeId: string) => runner.runSingleNode(nodeId), [runner]);
  const workflowRunning =
    snapshot.phase === 'running' ||
    snapshot.phase === 'waiting-for-user' ||
    snapshot.phase === 'cancelling';

  return {
    run,
    stop,
    runSingleNode,
    workflowRunning,
    phase: snapshot.phase,
    progress: snapshot.progress,
    diagnostics: snapshot.diagnostics,
    error: snapshot.error,
  };
}
