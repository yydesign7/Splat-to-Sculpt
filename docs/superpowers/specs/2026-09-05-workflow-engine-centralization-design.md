# Workflow Engine Centralization Design

## Context

The current application has a useful shared `workflow-engine.ts`, but it is not the execution authority. `FlowEditor` performs graph-wide propagation and completion checks while each node component owns its own auto-trigger `useEffect`, API calls, polling, status transitions, downstream writes, and cancellation details. The duplicated push paths are intentionally described as a safeguard, but in practice they allow the same state transition to be initiated from multiple places and make stale async results difficult to reject reliably.

This design centralizes orchestration without moving GPU, Blender, COLMAP, or ComfyUI work into the browser. The browser engine becomes the single workflow scheduler; existing API routes remain atomic local workers.

## Goals

- Establish one execution authority for readiness, scheduling, propagation, completion, failure, and cancellation.
- Define every supported node type once in a typed registry, including ports, defaults, execution mode, readiness, completion, and data transfer.
- Remove execution and downstream-propagation effects from React node components.
- Reject invalid graphs before execution: unknown node types, unknown handles, incompatible port data types, dangling edges, and cycles.
- Give every run a stable `runId` so late responses from an earlier run cannot mutate the active graph.
- Preserve parallel execution for independent DAG branches.
- Preserve interactive workflow steps such as manual upload and Surface Processing.
- Keep saved workflows portable by versioning and sanitizing their serialized graph.

## Non-goals

- No server-hosted distributed queue or multi-user orchestration service.
- No rewrite of reconstruction, Blender, mesh segmentation, or ComfyUI algorithms.
- No change to the current local-first ephemeral-file model.
- No UI redesign.
- No retry policy for destructive or costly jobs in the first version; retries remain explicit user actions.
- No restoration of Material Gen, Model History, point-cloud Auto Layers, or `layerFiles`.

## Architectural Decision

Use a client-side, registry-driven DAG scheduler as the single orchestration authority.

```text
React node UI ── user edits ──▶ React Flow graph
                                  │
                                  ▼
                         useWorkflowRunner
                                  │
                       validate + schedule + cancel
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
          typed node registry               node executors
       ports/readiness/status/data       API calls/polling/results
                  │                               │
                  └────────── output patch ───────┘
                                  │
                                  ▼
                       one propagation path
```

The engine owns *when* a node executes. Executors own *how* one node talks to its worker API. Components own display and explicit user input only.

## Node Contract

Each node definition must provide:

```ts
export type WorkflowValueKind = 'video' | 'frames' | 'pointcloud' | 'splat' | 'model' | 'video-stream';
export type WorkflowExecutionMode = 'manual-source' | 'automatic' | 'interactive' | 'passive-sink' | 'annotation';

export interface WorkflowPortDefinition {
  handle: string;
  valueKind: WorkflowValueKind;
  required: boolean;
}

export interface WorkflowNodeDefinition {
  type: WorkflowNodeType;
  mode: WorkflowExecutionMode;
  inputs: readonly WorkflowPortDefinition[];
  outputs: readonly WorkflowPortDefinition[];
  createDefaultData(): Record<string, unknown>;
  getReadiness(node: Node, graph: WorkflowGraph): NodeReadiness;
  getCompletion(node: Node): NodeCompletion;
  readOutput(node: Node, handle: string): WorkflowPacket | null;
  applyInput(node: Node, handle: string, packet: WorkflowPacket): Record<string, unknown>;
  resetData(node: Node): Record<string, unknown>;
  executor?: WorkflowNodeExecutor;
}
```

`WorkflowPacket` carries a declared value kind, the primary value, and typed metadata such as `lightParams`, `layerNames`, and `layerGlbUrls`. It does not carry legacy `layerFiles`.

The registry replaces these current duplicate authorities:

- `NODE_TYPE_CONFIGS`
- `FlowEditor.nodeTypes` type/default assumptions
- `FlowEditor.defaultDataMap`
- `SOURCE_HANDLE_MAP`
- `TARGET_HANDLE_MAP`
- the status switches in `workflow-engine.ts`
- per-node readiness rules embedded in component effects

React component registration remains a UI concern, but it is checked against the registry in a test so executable and renderable node types cannot drift.

## Graph Validation

`compileWorkflowGraph(nodes, edges)` returns either a compiled DAG or structured diagnostics. It must validate:

1. Node ids are unique.
2. Every node type exists in the registry.
3. Every edge endpoint exists.
4. Source and target handles exist on their node definitions.
5. Port value kinds are compatible.
6. At most one edge feeds a single-value input handle.
7. Annotation nodes have no execution edges.
8. The executable graph is acyclic.

The Run button must not start if validation produces an error. Diagnostics should identify the node or edge and be displayable in the top bar.

## Runtime State Machine

The workflow run is modeled separately from persisted node data:

```text
idle → validating → running ↔ waiting-for-user → completed
                         ├──→ failed
                         └──→ cancelling → cancelled

node: blocked → ready → running → succeeded
                         ├──→ failed
                         └──→ cancelled
```

Every run creates a `runId`. Every executor callback and result carries that id. The reducer ignores any action whose id differs from the active run. Stop first aborts client requests, then calls existing backend cancellation endpoints, and finally marks remaining running nodes cancelled.

## Scheduling Semantics

- Manual source nodes become satisfied when their user-provided output is complete.
- Automatic nodes run once per `runId` when all required connected inputs are present.
- Independent ready nodes start in the same scheduler pass.
- Interactive nodes move the run to `waiting-for-user`; the scheduler resumes automatically when their completion predicate becomes true.
- Passive sinks complete from propagated input without an executor.
- Annotation nodes are excluded from compilation and progress totals.
- A failed node blocks only its descendants, but the first version marks the whole run failed and keeps completed sibling outputs visible.
- A workflow completes when every executable terminal node is succeeded.

## Executor Boundary

Executors are framework-independent async functions. They receive a node snapshot, a run-scoped abort signal, session-aware `apiFetch`, and a progress callback. They return a data patch; they never call React setters or inspect React Flow directly.

```ts
export interface WorkflowNodeExecutorContext {
  runId: string;
  node: Node;
  signal: AbortSignal;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  reportProgress(patch: Record<string, unknown>): void;
}

export type WorkflowNodeExecutor = (
  context: WorkflowNodeExecutorContext,
) => Promise<Record<string, unknown>>;
```

Polling helpers currently embedded in components move beside their executor. Asset publication remains an executor-side postcondition initially, but it must be idempotent on the output URL. A later server queue can reuse the same executor contract without changing graph semantics.

## Persistence and Migration

Saved graphs gain `schemaVersion: 2`. Loading remains tolerant:

- remove Material Gen nodes;
- remove dangling edges and removed material handles;
- remove `layerFiles` from all node data;
- remove old Gaussian point-cloud `layerNames` while preserving Mesh Gen `layerNames` plus `layerGlbUrls`;
- fill missing current defaults from the registry;
- validate after migration.

Saving always writes the latest schema and excludes runtime-only fields. Existing `sanitizeLoadedWorkflowGraph` becomes the first v1-to-v2 migration rather than accumulating ad-hoc conditions in `FlowEditor`.

## Rollout

1. Introduce contracts, registry, migration, and graph compiler while retaining current execution.
2. Build and test the pure runtime reducer/scheduler.
3. Extract API executors from components one node family at a time.
4. Cut over `FlowEditor` to `useWorkflowRunner` only after all default-workflow executors are registered.
5. Remove node-level auto-trigger and downstream-push effects in the same cutover change to prevent dual execution.
6. Remove the old `workflow-engine.ts` maps and switches after parity tests pass.

## Acceptance Criteria

- One Run action produces at most one executor start per node per `runId`.
- A stale executor result after Stop/Clear/new Run is ignored.
- Invalid/cyclic graphs do not start and produce actionable diagnostics.
- Independent branches can run concurrently.
- The default eight-node workflow reaches completion using only the central runner.
- Surface Processing can pause the runner for user input and resume downstream execution.
- Stop cancels browser work and existing backend Gaussian/point-cloud/mesh work.
- Saved v1 workflows load through migration without Material Gen, dangling edges, or `layerFiles`.
- Node components contain no workflow auto-trigger or downstream propagation effects.
- `geometry_graph_surface`, `layerNames`, and `layerGlbUrls` continue to work end to end.
- Type checking, lint, unit tests, Python tests, and production build pass.
