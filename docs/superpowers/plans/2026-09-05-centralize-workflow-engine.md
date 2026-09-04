# Centralize Workflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace component-owned workflow execution with one typed, run-scoped DAG scheduler while preserving all current default-workflow behavior.

**Architecture:** A typed node registry defines ports, defaults, readiness, completion, transfer, and executors. A pure compiler and runtime reducer schedule the graph, while a single React hook adapts runtime events to React Flow node data; backend API routes remain atomic workers.

**Tech Stack:** TypeScript 5, React 19, Next.js 16 App Router, React Flow 12, Node test runner via `tsx`, Zod 4 (already installed), existing local API routes.

**Spec:** `docs/superpowers/specs/2026-09-05-workflow-engine-centralization-design.md`

## Global Constraints

- Use `pnpm` only; do not use npm or yarn.
- Do not restore Material Gen, Model History, point-cloud Auto Layers, or `layerFiles`.
- Preserve Mesh Gen `geometry_graph_surface`, `layerNames`, and `layerGlbUrls` behavior.
- Do not add implicit `any` or `as any`.
- Keep Three.js components client-only with dynamic import and `ssr: false`.
- Existing API routes remain the compute boundary; this plan centralizes orchestration, not heavy processing.
- Preserve user-authored saved workflows through versioned load migration.

---

### Task 1: Define Typed Workflow Contracts and a Single Node Registry

**Files:**
- Create: `src/lib/workflow/types.ts`
- Create: `src/lib/workflow/node-data.ts`
- Create: `src/lib/workflow/node-registry.ts`
- Create: `src/lib/workflow/node-registry.test.ts`
- Modify: `src/lib/node-config.ts`
- Modify: `src/lib/default-workflow.ts`
- Modify: `src/components/flow/FlowEditor.tsx`

**Interfaces:**
- Consumes: current node defaults, `NODE_TYPE_CONFIGS`, and the supported React Flow type strings.
- Produces: `WorkflowNodeType`, `WorkflowPacket`, `WorkflowNodeDefinition`, `WORKFLOW_NODE_REGISTRY`, `getWorkflowNodeDefinition(type)`, and `createDefaultNodeData(type)`.

- [ ] **Step 1: Write the failing registry consistency tests**

```ts
test('registry is the only source of executable node types and defaults', () => {
  const types = Object.keys(WORKFLOW_NODE_REGISTRY);
  assert.deepEqual(types.sort(), [
    'comfyVideo', 'frameExtraction', 'gaussianSplat', 'modelGeneration',
    'modelOrganize', 'modelSurface', 'stickyNote', 'videoPreview', 'videoUpload',
  ]);
  assert.equal(types.includes('material'), false);
  for (const type of types) {
    assert.equal(createDefaultNodeData(type as WorkflowNodeType).label.length > 0, true);
  }
});

test('registry ports never expose removed legacy contracts', () => {
  const serialized = JSON.stringify(WORKFLOW_NODE_REGISTRY);
  assert.equal(serialized.includes('layerFiles'), false);
  assert.equal(serialized.includes('texture-output'), false);
});
```

- [ ] **Step 2: Run the test and verify the registry does not exist yet**

Run: `pnpm exec tsx --test src/lib/workflow/node-registry.test.ts`

Expected: FAIL because `WORKFLOW_NODE_REGISTRY` is not defined.

- [ ] **Step 3: Add the shared contracts**

```ts
export type WorkflowNodeType =
  | 'videoUpload' | 'frameExtraction' | 'gaussianSplat'
  | 'modelGeneration' | 'modelOrganize' | 'modelSurface'
  | 'comfyVideo' | 'videoPreview' | 'stickyNote';

export type WorkflowValueKind =
  | 'video' | 'frames' | 'pointcloud' | 'splat' | 'model' | 'video-stream';

export type WorkflowExecutionMode =
  | 'manual-source' | 'automatic' | 'interactive' | 'passive-sink' | 'annotation';

export interface WorkflowGraph {
  nodes: Node[];
  edges: Edge[];
}

export interface WorkflowPortDefinition {
  handle: string;
  valueKind: WorkflowValueKind;
  required: boolean;
}

export interface NodeReadiness {
  ready: boolean;
  reason: string;
}

export interface NodeCompletion {
  complete: boolean;
  error: string | null;
}

export interface WorkflowPacket {
  kind: WorkflowValueKind;
  value: unknown;
  metadata: Record<string, unknown>;
}

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

export interface WorkflowNodeDefinition {
  type: WorkflowNodeType;
  label: string;
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

- [ ] **Step 4: Implement definitions for all nine supported node types**

Use `satisfies Record<WorkflowNodeType, WorkflowNodeDefinition>` so missing definitions are a compile error. Put `layerNames`, `layerGlbUrls`, `lightParams`, `gaussianCount`, and `computeBackend` in packet metadata where needed. Do not include `layerFiles` or a Mesh Gen texture port.

- [ ] **Step 5: Replace duplicated default maps with registry defaults**

Change `FlowEditor.getClearedNodeData`, node creation, workflow save cleanup, and `default-workflow.ts` to call `createDefaultNodeData(type)`. Derive `NODE_TYPE_CONFIGS` from registry presentation fields instead of maintaining a second node list.

- [ ] **Step 6: Run tests and static checks**

Run: `pnpm exec tsx --test src/lib/workflow/node-registry.test.ts src/lib/default-workflow-comfy.test.ts src/lib/workflow-clear.test.ts`

Run: `pnpm ts-check && pnpm lint`

Expected: all pass; default workflow structure and Comfy preset remain unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/lib/workflow src/lib/node-config.ts src/lib/default-workflow.ts src/components/flow/FlowEditor.tsx
git commit -m "refactor: centralize workflow node contracts"
```

### Task 2: Version Saved Workflows and Compile Validated DAGs

**Files:**
- Create: `src/lib/workflow/schema.ts`
- Create: `src/lib/workflow/migrations.ts`
- Create: `src/lib/workflow/migrations.test.ts`
- Create: `src/lib/workflow/graph-compiler.ts`
- Create: `src/lib/workflow/graph-compiler.test.ts`
- Modify: `src/lib/workflow-load-sanitizer.ts`
- Modify: `src/lib/workflow-load-sanitizer.test.ts`
- Modify: `src/app/api/workflow-library/route.ts`
- Modify: `src/components/flow/FlowEditor.tsx`

**Interfaces:**
- Consumes: `WORKFLOW_NODE_REGISTRY`, current v1 saved `{ nodes, edges }` entries, and React Flow `Node`/`Edge`.
- Produces: `SAVED_WORKFLOW_SCHEMA_VERSION = 2`, `migrateSavedWorkflow(input)`, `compileWorkflowGraph(nodes, edges)`, `CompiledWorkflowGraph`, and `WorkflowDiagnostic`.

- [ ] **Step 1: Write failing migration and compiler tests**

```ts
test('v1 migration strips removed nodes, handles, and runtime fields', () => {
  const result = migrateSavedWorkflow({ nodes: legacyNodes, edges: legacyEdges });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.nodes.some((node) => node.type === 'material'), false);
  assert.equal(JSON.stringify(result.nodes).includes('layerFiles'), false);
  assert.equal(result.edges.some((edge) => edge.targetHandle === 'texture'), false);
});

test('compiler rejects cycles and incompatible ports', () => {
  const result = compileWorkflowGraph(cyclicNodes, cyclicEdges);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((item) => item.code === 'GRAPH_CYCLE'), true);
});
```

- [ ] **Step 2: Run the tests and verify they fail for missing migration/compiler exports**

Run: `pnpm exec tsx --test src/lib/workflow/migrations.test.ts src/lib/workflow/graph-compiler.test.ts`

Expected: FAIL before implementation.

- [ ] **Step 3: Define the Zod persistence schema and migration**

Use `z.object`/`z.array` for the serialized graph envelope and keep node `data` as `z.record(z.string(), z.unknown())`. `migrateSavedWorkflow` must clone input, run the existing legacy sanitizer as v1→v2, merge registry defaults, and return v2 without runtime status/output fields.

- [ ] **Step 4: Implement the graph compiler with structured diagnostics**

```ts
export type WorkflowDiagnosticCode =
  | 'DUPLICATE_NODE_ID' | 'UNKNOWN_NODE_TYPE' | 'DANGLING_EDGE'
  | 'UNKNOWN_SOURCE_HANDLE' | 'UNKNOWN_TARGET_HANDLE'
  | 'INCOMPATIBLE_PORTS' | 'MULTIPLE_SINGLE_INPUTS' | 'GRAPH_CYCLE';

export type CompileWorkflowResult =
  | { ok: true; graph: CompiledWorkflowGraph; diagnostics: [] }
  | { ok: false; diagnostics: WorkflowDiagnostic[] };
```

Use Kahn's algorithm to produce `topologicalOrder`, plus incoming/outgoing edge maps keyed by node id. Annotation nodes remain in the canvas graph but are excluded from executable adjacency.

- [ ] **Step 5: Integrate migration at load/save and validation at Run**

`FlowEditor.handleLoadWorkflow` calls `migrateSavedWorkflow`. Save sends `{ schemaVersion: 2, nodes, edges }`. `handleRun` calls `compileWorkflowGraph`; on failure it does not set `workflowRunning` and passes the first diagnostic to TopBar.

- [ ] **Step 6: Run focused and full library tests**

Run: `pnpm exec tsx --test src/lib/workflow/*.test.ts src/lib/workflow-load-sanitizer.test.ts`

Run: `pnpm ts-check && pnpm lint`

Expected: all pass, including v1 migration and cycle rejection.

- [ ] **Step 7: Commit**

```bash
git add src/lib/workflow src/lib/workflow-load-sanitizer.ts src/lib/workflow-load-sanitizer.test.ts src/app/api/workflow-library/route.ts src/components/flow/FlowEditor.tsx
git commit -m "feat: validate and version saved workflow graphs"
```

### Task 3: Build the Run-scoped Scheduler and Reducer

**Files:**
- Create: `src/lib/workflow/runtime-state.ts`
- Create: `src/lib/workflow/runtime-reducer.ts`
- Create: `src/lib/workflow/scheduler.ts`
- Create: `src/lib/workflow/scheduler.test.ts`

**Interfaces:**
- Consumes: `CompiledWorkflowGraph`, registry readiness/completion functions, and executor callbacks supplied by the host.
- Produces: `WorkflowRunState`, `WorkflowRunAction`, `workflowRunReducer`, `findReadyNodeIds`, `isRunComplete`, and stale-action rejection by `runId`.

- [ ] **Step 1: Write failing state-machine tests**

```ts
test('one node starts only once per run and stale completions are ignored', () => {
  const running = reduceActions(createRun('run-2'), [
    { type: 'NODE_STARTED', runId: 'run-2', nodeId: 'mesh' },
    { type: 'NODE_STARTED', runId: 'run-2', nodeId: 'mesh' },
    { type: 'NODE_SUCCEEDED', runId: 'run-1', nodeId: 'mesh' },
  ]);
  assert.equal(running.nodes.mesh.phase, 'running');
  assert.equal(running.nodes.mesh.attempt, 1);
});

test('independent ready branches are returned in one scheduler pass', () => {
  assert.deepEqual(findReadyNodeIds(compiledForkGraph, runState).sort(), ['branch-a', 'branch-b']);
});
```

- [ ] **Step 2: Run the scheduler tests and verify RED**

Run: `pnpm exec tsx --test src/lib/workflow/scheduler.test.ts`

Expected: FAIL because the runtime reducer and scheduler do not exist.

- [ ] **Step 3: Implement explicit run and node states**

```ts
export type WorkflowRunPhase =
  | 'idle' | 'validating' | 'running' | 'waiting-for-user'
  | 'cancelling' | 'cancelled' | 'failed' | 'completed';

export type WorkflowNodeRunPhase =
  | 'blocked' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkflowRunState {
  runId: string | null;
  phase: WorkflowRunPhase;
  nodes: Record<string, WorkflowNodeRunState>;
  error: string | null;
}
```

The reducer must return the unchanged state for any run-scoped action whose `runId` is not current, and for a duplicate `NODE_STARTED` action.

- [ ] **Step 4: Implement pure scheduling decisions**

`findReadyNodeIds` checks predecessor success, registry readiness, execution mode, and current node phase. Return all ready automatic nodes so the React host can launch them concurrently. `isRunComplete` checks executable terminal ids from the compiled graph.

- [ ] **Step 5: Cover manual and interactive states**

Add tests showing a completed manual Video Upload unlocks Frame Extraction and an incomplete interactive Surface Processing changes the run phase to `waiting-for-user` without starting an executor.

- [ ] **Step 6: Run focused tests and checks**

Run: `pnpm exec tsx --test src/lib/workflow/scheduler.test.ts src/lib/workflow/graph-compiler.test.ts`

Run: `pnpm ts-check && pnpm lint`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/workflow/runtime-state.ts src/lib/workflow/runtime-reducer.ts src/lib/workflow/scheduler.ts src/lib/workflow/scheduler.test.ts
git commit -m "feat: add run-scoped workflow scheduler"
```

### Task 4: Extract Reconstruction Executors from React Components

**Files:**
- Create: `src/lib/workflow/executors/frame-extraction.ts`
- Create: `src/lib/workflow/executors/gaussian-splat.ts`
- Create: `src/lib/workflow/executors/mesh-generation.ts`
- Create: `src/lib/workflow/executors/reconstruction-executors.test.ts`
- Modify: `src/components/flow/custom-nodes.tsx`
- Modify: `src/lib/workflow/node-registry.ts`

**Interfaces:**
- Consumes: `WorkflowNodeExecutorContext`, existing API payloads, Gaussian polling constants, and mesh task status payloads.
- Produces: `executeFrameExtraction`, `executeGaussianSplat`, and `executeMeshGeneration`, each returning one node-data output patch.

- [ ] **Step 1: Write failing executor contract tests with a scripted fetch fake**

```ts
test('Gaussian executor reports progress and returns only current output fields', async () => {
  const patches: Record<string, unknown>[] = [];
  const result = await executeGaussianSplat(makeContext({
    fetchSteps: [startedResponse, processingResponse, doneResponse],
    reportProgress: (patch) => patches.push(patch),
  }));
  assert.equal(patches[0].status, 'processing');
  assert.equal(result.status, 'done');
  assert.equal(result.splatUrl, '/api/ephemeral-file?id=session&path=out.ply');
  assert.equal(Object.hasOwn(result, 'layerFiles'), false);
});
```

- [ ] **Step 2: Run the test and verify executor exports are missing**

Run: `pnpm exec tsx --test src/lib/workflow/executors/reconstruction-executors.test.ts`

Expected: FAIL before extraction.

- [ ] **Step 3: Move API and polling logic into pure executors**

Move `waitForGaussianTask` and mesh polling out of `custom-nodes.tsx`. Every fetch call receives `signal`; polling checks `signal.aborted` before waiting and before reporting progress. Return patches instead of calling `setNodes`.

- [ ] **Step 4: Register the three executors**

```ts
frameExtraction: { ...definition, executor: executeFrameExtraction },
gaussianSplat: { ...definition, executor: executeGaussianSplat },
modelGeneration: { ...definition, executor: executeMeshGeneration },
```

- [ ] **Step 5: Route component actions through the extracted executors**

Until Task 6 introduces the runner, a small component adapter constructs `WorkflowNodeExecutorContext` from the current node snapshot, `apiFetch`, an `AbortController`, and a `setNodes`-backed `reportProgress`. Manual buttons and the existing auto-trigger effect call the same executor. Remove the duplicated API/polling bodies, but leave scheduling and propagation effects until the atomic Task 6 cutover.

- [ ] **Step 6: Run executor tests and the existing Gaussian/mesh policy tests**

Run: `pnpm exec tsx --test src/lib/workflow/executors/reconstruction-executors.test.ts src/lib/gaussian-*.test.ts src/lib/mesh-*.test.ts`

Run: `pnpm ts-check && pnpm lint`

Expected: all pass and no executor imports React.

- [ ] **Step 7: Commit**

```bash
git add src/lib/workflow/executors src/lib/workflow/node-registry.ts src/components/flow/custom-nodes.tsx
git commit -m "refactor: extract reconstruction node executors"
```

### Task 5: Extract Blender, ComfyUI, and Output Executors

**Files:**
- Create: `src/lib/workflow/executors/model-cleanup.ts`
- Create: `src/lib/workflow/executors/surface-processing.ts`
- Create: `src/lib/workflow/executors/comfy-video.ts`
- Create: `src/lib/workflow/executors/video-preview.ts`
- Create: `src/lib/workflow/executors/output-executors.test.ts`
- Modify: `src/components/flow/custom-nodes.tsx`
- Modify: `src/lib/workflow/node-registry.ts`

**Interfaces:**
- Consumes: the executor contract, `/api/blender-organize`, `/api/blender-material`, `/api/merge-glb`, `/api/generate-comfy-video`, and `/api/generate-rotation-video`.
- Produces: `executeModelCleanup`, `executeSurfaceProcessing`, `executeComfyVideo`, and `executeVideoPreview`.

- [ ] **Step 1: Write failing tests for layered cleanup, interactive surface output, and video paths**

```ts
test('cleanup preserves Mesh Gen layer metadata', async () => {
  const result = await executeModelCleanup(makeContextWithLayers());
  assert.deepEqual(result.layerNames, ['Body', 'Base']);
  assert.deepEqual(result.layerGlbUrls, ['/clean/body.glb', '/clean/base.glb']);
  assert.equal(Object.hasOwn(result, 'layerFiles'), false);
});

test('video preview is passive for video input and executes for model input', () => {
  assert.equal(getVideoPreviewExecutionMode({ videoUrl: '/out.mp4' }), 'passive-sink');
  assert.equal(getVideoPreviewExecutionMode({ modelUrl: '/model.glb' }), 'automatic');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm exec tsx --test src/lib/workflow/executors/output-executors.test.ts`

Expected: FAIL before extraction.

- [ ] **Step 3: Extract cleanup and video executors**

Keep per-layer cleanup sequential inside one node execution to preserve result ordering. ComfyUI and rotation-video polling/reporting use the run abort signal and return the final `videoUrl`/`videoName` patch.

- [ ] **Step 4: Model Surface Processing as an interactive node**

Define Surface Processing as `interactive` in the registry. During this extraction task, Apply uses the temporary executor adapter from Task 4; after the Task 6 cutover, the same button invokes `runSingleNode(id)`. The executor performs merge/Blender work and returns `outputModelUrl`, `outputModelType`, `layerNames`, `layerGlbUrls`, and `lightParams`; until Apply succeeds, the central scheduler reports `waiting-for-user`.

- [ ] **Step 5: Register executors and replace component API bodies**

Nodes retain file pickers, parameter controls, and viewers. Remove their direct worker API/polling code after the equivalent executor test passes.

- [ ] **Step 6: Run output tests and Comfy workflow tests**

Run: `pnpm exec tsx --test src/lib/workflow/executors/output-executors.test.ts src/lib/comfyui-workflow.test.ts src/lib/default-workflow-comfy.test.ts`

Run: `pnpm ts-check && pnpm lint`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/workflow/executors src/lib/workflow/node-registry.ts src/components/flow/custom-nodes.tsx
git commit -m "refactor: extract output node executors"
```

### Task 6: Integrate the Single React Runner and Remove Dual Execution

**Files:**
- Create: `src/lib/workflow/runner.ts`
- Create: `src/lib/workflow/runner.test.ts`
- Create: `src/hooks/use-workflow-runner.ts`
- Modify: `src/lib/workflow-context.ts`
- Modify: `src/components/flow/FlowEditor.tsx`
- Modify: `src/components/flow/TopBar.tsx`
- Modify: `src/components/flow/custom-nodes.tsx`
- Delete: `src/lib/workflow-engine.ts`
- Modify: tests importing `src/lib/workflow-engine.ts` to use registry/compiler/runtime APIs.

**Interfaces:**
- Consumes: compiled graph, registry executors, runtime reducer/scheduler, `workflowApiFetch`, and React Flow setters.
- Produces: framework-independent `createWorkflowRunner(...)` plus `useWorkflowRunner({ nodes, edges, setNodes })` with `run`, `stop`, `runSingleNode`, `phase`, `progress`, and `diagnostics`.

- [ ] **Step 1: Write failing integration tests for one-start, propagation, stop, and stale results**

```ts
test('runner starts each ready executor once and propagates one result once', async () => {
  const harness = createRunnerHarness(linearGraph, executors);
  await harness.run();
  assert.equal(executors.frameExtraction.calls.length, 1);
  assert.equal(executors.gaussianSplat.calls.length, 1);
  assert.equal(harness.inputWritesTo('gaussianSplat'), 1);
});

test('result from a stopped run cannot update nodes', async () => {
  const harness = createDeferredRunnerHarness();
  const firstRun = harness.run();
  harness.stop();
  harness.resolveExecutor({ frames: ['/stale.jpg'] });
  await firstRun;
  assert.equal(harness.nodesContain('/stale.jpg'), false);
});
```

- [ ] **Step 2: Run the integration tests and verify RED**

Run: `pnpm exec tsx --test src/lib/workflow/runner.test.ts`

Expected: FAIL because the runner host is missing.

- [ ] **Step 3: Implement the hook with run-scoped AbortControllers**

Implement these mechanics first in `createWorkflowRunner`, with injected graph getters, node-patch callbacks, and `apiFetch`, so Node tests do not require a DOM renderer. `run()` compiles the latest graph, creates `crypto.randomUUID()`, initializes reducer state, propagates already-complete manual sources, then launches every id from `findReadyNodeIds` with `Promise.allSettled`. Executor progress and result callbacks check the active `runId` before applying one batched node update. `useWorkflowRunner` is a thin React lifecycle adapter around this tested host.

- [ ] **Step 4: Implement stop and backend cancellation**

`stop()` aborts all node controllers, dispatches `RUN_CANCELLING`, calls `/api/cancel-workflow-tasks`, then dispatches `RUN_CANCELLED` only if the same run is still active. Clear calls `stop()` before regenerating node ids, which makes any stale closure unable to match a current node.

- [ ] **Step 5: Cut over FlowEditor and context**

Replace `workflowRunning` ownership with runner `phase`. Expose `runSingleNode` to node buttons. TopBar derives Run/Stop/progress/error display from the runner. Remove FlowEditor’s unified push effect, auto-stop effect, and local terminal-node helpers.

- [ ] **Step 6: Remove all component auto-trigger and downstream-write effects**

Search before editing:

```bash
rg -n "workflowRunning|downstreamEdges|Push .*downstream|Auto-trigger" src/components/flow/custom-nodes.tsx src/components/flow/FlowEditor.tsx
```

Delete only execution/propagation effects. Keep state synchronization, blob cleanup, viewer setup, and user-input effects. Then delete `workflow-engine.ts` and move any still-needed pure edge-color helper to `src/lib/workflow/edge-style.ts`.

- [ ] **Step 7: Run integration and full TypeScript tests**

Run: `pnpm exec tsx --test src/lib/*.test.ts src/lib/workflow/**/*.test.ts`

Run: `pnpm ts-check && pnpm lint`

Expected: all pass; the search shows no node auto-trigger or downstream-write effect.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/use-workflow-runner.ts src/lib/workflow-context.ts src/lib/workflow src/components/flow/FlowEditor.tsx src/components/flow/TopBar.tsx src/components/flow/custom-nodes.tsx
git rm src/lib/workflow-engine.ts
git commit -m "feat: make workflow runner the single execution authority"
```

### Task 7: Verify Default Workflow Parity and Document the Engine

**Files:**
- Create: `src/lib/workflow/default-workflow-runtime.test.ts`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: complete central runner and the built-in default graph.
- Produces: a deterministic default-workflow contract test and current architecture documentation.

- [ ] **Step 1: Add a deterministic eight-node workflow test**

Use fake executors with deferred promises to assert exact start order constraints:

```ts
assert.deepEqual(started, ['frameExtraction']);
resolve('frameExtraction');
assert.deepEqual(started, ['frameExtraction', 'gaussianSplat']);
// Continue through mesh and cleanup, pause at interactive surface, then resume.
assert.equal(harness.phase, 'waiting-for-user');
await harness.runSingleNode('surface');
resolve('comfyVideo');
assert.equal(executors.comfyVideo.calls.length, 1);
assert.equal(executors.videoPreview.calls.length, 0);
assert.equal(harness.nodePhase('videoPreview'), 'succeeded');
assert.equal(harness.phase, 'completed');
```

- [ ] **Step 2: Run the parity test and fix only contract mismatches**

Run: `pnpm exec tsx --test src/lib/workflow/default-workflow-runtime.test.ts`

Expected: PASS with each automatic node executed exactly once and no `layerFiles` in any node or packet.

- [ ] **Step 3: Update architecture documentation**

Document the registry, compiler, run state machine, executor boundary, interactive pause/resume, cancellation, schema version, and commands for focused engine tests. Remove statements claiming node-level effects or dual data push are part of the architecture.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
pnpm exec tsx --test src/lib/*.test.ts src/lib/workflow/**/*.test.ts
pnpm ts-check
pnpm lint
pnpm exec next build --webpack
```

Run every tracked `scripts/test_*.py` with the configured project Python interpreter, then run `node scripts/test_interactive_viewer_drag_rendering.mjs`.

Expected: all checks pass; production build lists only current API routes.

- [ ] **Step 5: Perform the removal audit**

Run:

```bash
rg -n "Material Gen|model-history|layerFiles|enableSegmentation|pointcloud_segment|workflowRunning.*useEffect|downstreamEdges" src README.md README.zh-CN.md AGENTS.md
```

Expected: matches only migration/regression fixtures that deliberately contain legacy input names; no runtime path or current architecture prose references removed features or decentralized execution.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workflow/default-workflow-runtime.test.ts README.md README.zh-CN.md AGENTS.md
git commit -m "test: verify centralized workflow parity"
```

## Completion Gate

Do not call the centralization complete until all acceptance criteria in the design spec are covered by an automated test or a documented manual check, the full verification matrix passes, and a review confirms no node component can independently auto-start or push downstream data.
