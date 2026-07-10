'use client';

import { createContext, useContext, useCallback } from 'react';

export interface WorkflowContextValue {
  /** Whether the workflow is currently in "run" mode — nodes should auto-trigger when inputs are ready */
  workflowRunning: boolean;
  setWorkflowRunning: (running: boolean) => void;
  /**
   * Browser tab session for ephemeral workflow files. Null only before first mount completes.
   */
  ephemeralSessionId: string | null;
  /** fetch() with X-Ephemeral-Session-Id for routes that write under .data/ephemeral */
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const rejectFetch = () => Promise.reject(new Error('Workflow session not ready'));

const WorkflowContext = createContext<WorkflowContextValue>({
  workflowRunning: false,
  setWorkflowRunning: () => {},
  ephemeralSessionId: null,
  apiFetch: rejectFetch,
});

export function useWorkflow() {
  return useContext(WorkflowContext);
}

/** Stable apiFetch bound to current session — for hooks that need [apiFetch] deps */
export function useWorkflowApiFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const { apiFetch } = useWorkflow();
  return useCallback((input: RequestInfo | URL, init?: RequestInit) => apiFetch(input, init), [apiFetch]);
}

export { WorkflowContext };
