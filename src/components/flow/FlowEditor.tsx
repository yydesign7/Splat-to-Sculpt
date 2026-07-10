'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
  type OnConnect,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import Sidebar from './Sidebar';
import TopBar from './TopBar';
import {
  VideoUploadNode,
  FrameExtractionNode,
  MaterialNode,
  ModelOrganizeNode,
  VideoPreviewNode,
  ModelSurfaceNode,
  ModelGenerationNode,
  GaussianSplatNode,
  StickyNoteNode,
} from './custom-nodes';
import { WorkflowContext } from '@/lib/workflow-context';
import { workflowApiFetch } from '@/lib/workflow-api-fetch';
import { computeDownstreamPushes, isNodeDone } from '@/lib/workflow-engine';
import { getNodeVisualTheme } from '@/lib/node-config';
import { initialEdges, initialNodes } from '@/lib/default-workflow';

/* ========== Node Types Registry ========== */
const nodeTypes: NodeTypes = {
  videoUpload: VideoUploadNode,
  frameExtraction: FrameExtractionNode,
  gaussianSplat: GaussianSplatNode,
  material: MaterialNode,
  modelOrganize: ModelOrganizeNode,
  videoPreview: VideoPreviewNode,
  modelSurface: ModelSurfaceNode,
  modelGeneration: ModelGenerationNode,
  stickyNote: StickyNoteNode,
};

/* ========== Stable ReactFlow Configs (module-level to avoid re-renders) ========== */
const fitViewOptions = { padding: 0.2 };
const defaultEdgeOptions = {
  type: 'default' as const,
  animated: false,
  style: { strokeWidth: 2, strokeDasharray: '5 3' },
};
const proOptions = { hideAttribution: true };
const getMinimapNodeColor = (node: Node) => getNodeVisualTheme(node.type || '').accent;

function getTerminalWorkflowNodes(nodes: Node[], edges: Edge[]) {
  const connectedNodeIds = new Set<string>();
  const sourceNodeIds = new Set<string>();

  for (const edge of edges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
    sourceNodeIds.add(edge.source);
  }

  return nodes.filter(
    (node) =>
      node.type !== 'stickyNote' &&
      connectedNodeIds.has(node.id) &&
      !sourceNodeIds.has(node.id)
  );
}

function getConnectedWorkflowNodes(nodes: Node[], edges: Edge[]) {
  const connectedNodeIds = new Set<string>();
  for (const edge of edges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  }
  const connected = nodes.filter((node) => node.type !== 'stickyNote' && connectedNodeIds.has(node.id));
  return connected.length > 0 ? connected : nodes.filter((node) => node.type !== 'stickyNote');
}

function areWorkflowValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => areWorkflowValuesEqual(item, b[index]));
  }

  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    Object.getPrototypeOf(a) === Object.prototype &&
    Object.getPrototypeOf(b) === Object.prototype
  ) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => (
        Object.prototype.hasOwnProperty.call(bRecord, key) &&
        areWorkflowValuesEqual(aRecord[key], bRecord[key])
      ))
    );
  }

  return false;
}

/* ========== Default Node Data Map ========== */
type NodeKind =
  | 'videoUpload'
  | 'frameExtraction'
  | 'gaussianSplat'
  | 'material'
  | 'modelOrganize'
  | 'videoPreview'
  | 'modelSurface'
  | 'modelGeneration'
  | 'stickyNote';

const defaultDataMap: Record<NodeKind, Record<string, unknown>> = {
  videoUpload: {
    label: 'Video Upload',
    videoUrl: null,
    coverUrl: null,
    videoName: null,
    videoServerPath: null,
    uploadStatus: 'idle',
    uploadError: null,
    targetFrameCount: 120,
  },
  frameExtraction: { label: 'Frame Extraction', videoServerPath: null, targetFrameCount: 120, frames: [], outputFolder: null, frameCount: 0, status: 'idle', errorMessage: null },
  gaussianSplat: { label: 'Gaussian Splat Gen', framePaths: [], sourcePlyUrl: null, splatUrl: null, gaussianCount: null, status: 'idle', progressText: null, progressStep: null, errorMessage: null, trainingIterations: 1000, currentTrainingIteration: null, maxTrainingIterations: null, activeTaskId: null, deviceType: null, computeBackend: null, trainingMode: 'auto', targetPlyType: null, trueTrainingAvailable: null, trueTrainingUnavailableReason: null, layerFiles: [], layerNames: [] },
  material: { label: 'Material Gen', status: 'idle', textureCount: null, textInput: '', textureUrl: null, errorMessage: null },
  modelOrganize: { label: 'Model Cleanup', modelUrl: null, outputUrl: null, outputType: null, isFullscreen: false, organizeStatus: 'idle', errorMessage: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  videoPreview: { label: 'Video Preview', videoUrl: null, videoName: null, modelUrl: null, videoGenerating: false, errorMessage: null, lightParams: null },
  modelSurface: { label: 'Surface Processing', materialFileName: null, materialPreviewUrl: null, modelUrl: null, outputModelUrl: null, outputModelType: null, selectedLayer: null, blenderProcessing: false, blenderError: null, materialParams: { base_color: [0.8, 0.75, 0.7], metallic: 0.0, roughness: 0.5, emissive_color: [0.0, 0.0, 0.0], emissive_strength: 0.0, alpha: 1.0, normal_scale: 1.0 }, renderUrl: null, layerParams: {}, lightParams: { ambientIntensity: 0.6, mainLightIntensity: 0.8, mainLightColor: [1, 1, 1], mainLightAzimuth: 45, mainLightElevation: 45, fillLightIntensity: 0.3, fillLightAzimuth: -135, fillLightElevation: 30, exposure: 1.0 }, layerFiles: [], layerNames: [], layerGlbUrls: [], layerUrlA: {}, layerUrlB: {}, layerUrlC: {} },
  modelGeneration: { label: 'Mesh Gen', modelUrl: null, isFullscreen: false, inputType: null, outputUrl: null, outputType: null, textureUrl: null, meshStatus: 'idle', outputFormat: 'glb', errorMessage: null, faceCount: null, gaussianCount: null, computeBackend: null, renderUrl: null, lightParams: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  stickyNote: { label: 'Sticky Note', text: '' },
};

function cloneDefaultData(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

function getClearedNodeData(node: Node): Record<string, unknown> {
  const defaults = defaultDataMap[node.type as NodeKind];
  if (!defaults) return { ...(node.data as Record<string, unknown>) };

  const cleared = cloneDefaultData(defaults);
  if (node.type === 'stickyNote') {
    const current = node.data as Record<string, unknown>;
    cleared.text = typeof current.text === 'string' ? current.text : '';
    cleared.label = typeof current.label === 'string' ? current.label : cleared.label;
  }
  return cleared;
}

/* ========== Edge color by source handle type ========== */
function getEdgeColor(sourceHandle: string | null | undefined, sourceNodeType?: string): string {
  if (!sourceHandle) return '#5a5870';
  // Video handles → video upload node header color
  if (sourceHandle === 'video-output') return '#4a6a8a';
  if (sourceHandle === 'output' && sourceNodeType === 'videoUpload') return '#4a6a8a';
  if (sourceHandle === 'output' && sourceNodeType === 'videoPreview') return '#4a6a8a';
  // Texture/material handles
  if (sourceHandle === 'texture-output') return '#aa8a5a';
  // Frame handles → frame extraction node header color
  if (sourceHandle === 'output' && sourceNodeType === 'frameExtraction') return '#6b5f7a';
  // Model handles → 3DGS model generation node header color
  if (sourceHandle === 'splat-output') return '#6f5aa8';
  if (sourceHandle === 'mesh-output') return '#7a4a55';
  if (['ply-output', 'obj-output'].includes(sourceHandle)) return '#7a4a55';
  if (sourceHandle === 'output') return '#7a4a55';
  return '#7a4a55';
}

/* ========== Flow Editor Inner ========== */
const EPHEMERAL_SESSION_STORAGE_KEY = 'wf_ephemeral_session_id';

async function cancelWorkflowTasksForSession(sessionId: string) {
  await fetch('/api/cancel-workflow-tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ephemeral-Session-Id': sessionId,
    },
    body: JSON.stringify({}),
  }).catch(() => {});
}

function FlowEditorInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [ephemeralSessionId, setEphemeralSessionId] = useState<string | null>(null);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const prev = typeof window !== 'undefined' ? sessionStorage.getItem(EPHEMERAL_SESSION_STORAGE_KEY) : null;
      if (prev) {
        await cancelWorkflowTasksForSession(prev);
        await fetch('/api/ephemeral-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cleanup', sessionId: prev }),
        }).catch(() => {});
      }
      if (cancelled) return;
      const id = crypto.randomUUID();
      sessionStorage.setItem(EPHEMERAL_SESSION_STORAGE_KEY, id);
      setEphemeralSessionId(id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const apiFetch = useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => {
      if (!ephemeralSessionId) {
        return Promise.reject(new Error('Workflow session not ready'));
      }
      return workflowApiFetch(ephemeralSessionId, input, init);
    },
    [ephemeralSessionId],
  );

  /* ---- Connection ---- */
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (sourceNode?.type === 'stickyNote' || targetNode?.type === 'stickyNote') {
        return;
      }
      const edgeColor = getEdgeColor(connection.sourceHandle, sourceNode?.type);
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: 'default',
            animated: false,
            style: { stroke: edgeColor, strokeWidth: 2, strokeDasharray: '5 3' },
          },
          eds
        )
      );
    },
    [setEdges, nodes]
  );

  /* ---- Edge animation: animate when source is done and target is not yet done ---- */
  useEffect(() => {
    setEdges((eds) =>
      eds.map((edge) => {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        const targetNode = nodes.find((n) => n.id === edge.target);

        const sourceDone = isNodeDone(sourceNode);
        const targetDone = isNodeDone(targetNode);

        const shouldAnimate = sourceDone && !targetDone;

        if (edge.animated === shouldAnimate) return edge;

        return { ...edge, animated: shouldAnimate };
      })
    );
  }, [nodes, setEdges]);

  /* ---- Unified data push: when a node completes, auto-push data to downstream ---- */
  useEffect(() => {
    if (!workflowRunning) return;

    // Find all nodes that just completed (done + not yet pushed to downstream)
    const pushUpdates: Array<{ targetNodeId: string; updates: Record<string, unknown> }> = [];

    for (const node of nodes) {
      if (!isNodeDone(node)) continue;

      const pushes = computeDownstreamPushes(node, edges, nodes);
      for (const push of pushes) {
        // Only push if the target node doesn't already have the data
        const targetNode = nodes.find((n) => n.id === push.targetNodeId);
        if (!targetNode) continue;

        // Check if any field in the update is different from current data
        const hasNewData = Object.entries(push.updates).some(
          ([key, value]) => !areWorkflowValuesEqual(targetNode.data[key], value)
        );
        if (hasNewData) {
          pushUpdates.push(push);
        }
      }
    }

    if (pushUpdates.length === 0) return;

    // Apply all pushes in a single setNodes call
    setNodes((nds) =>
      nds.map((n) => {
        const updatesForNode = pushUpdates
          .filter((p) => p.targetNodeId === n.id)
          .reduce<Record<string, unknown>>((acc, p) => ({ ...acc, ...p.updates }), {});

        if (Object.keys(updatesForNode).length === 0) return n;

        let nextUpdates = updatesForNode;
        if (
          n.type === 'gaussianSplat' &&
          Array.isArray(updatesForNode.framePaths) &&
          !areWorkflowValuesEqual(n.data.framePaths, updatesForNode.framePaths)
        ) {
          nextUpdates = {
            ...updatesForNode,
            sourcePlyUrl: null,
            splatUrl: null,
            gaussianCount: null,
            status: 'idle',
            progressText: null,
            progressStep: null,
            errorMessage: null,
            computeBackend: null,
            targetPlyType: null,
            currentTrainingIteration: null,
            maxTrainingIterations: null,
            activeTaskId: null,
          };
        }

        const hasNewData = Object.entries(nextUpdates).some(
          ([key, value]) => !areWorkflowValuesEqual(n.data[key], value)
        );
        if (!hasNewData) return n;
        return { ...n, data: { ...n.data, ...nextUpdates } };
      })
    );
  }, [nodes, edges, workflowRunning, setNodes]);

  /* ---- Auto-stop workflow when all terminal workflow nodes are done ---- */
  useEffect(() => {
    if (!workflowRunning) return;

    const terminalNodes = getTerminalWorkflowNodes(nodes, edges);
    if (terminalNodes.length === 0) return;

    const allTerminalNodesDone = terminalNodes.every((node) => isNodeDone(node));
    if (allTerminalNodesDone) {
      setWorkflowRunning(false);
    }
  }, [nodes, edges, workflowRunning]);

  /* ---- Drag & Drop ---- */
  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Determine drop effect based on what's being dragged
    const hasAsset = event.dataTransfer.types.includes('application/asset');
    event.dataTransfer.dropEffect = hasAsset ? 'copy' : 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();

      // --- Asset drop: fill asset URL into an existing node ---
      const assetDataStr = event.dataTransfer.getData('application/asset');
      if (assetDataStr) {
        try {
          const assetData = JSON.parse(assetDataStr) as {
            id: string;
            assetType: string;
            fileUrl: string;
            fileType: string;
            name: string;
          };

          const flowPos = screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });

          // Find the node under the drop position
          const targetNode = nodes.find((n) => {
            const nodeWidth = 280;
            const nodeHeight = 200;
            return (
              flowPos.x >= n.position.x &&
              flowPos.x <= n.position.x + nodeWidth &&
              flowPos.y >= n.position.y &&
              flowPos.y <= n.position.y + nodeHeight
            );
          });

          if (!targetNode) return;

          // Map asset type + node type → field updates
          let updates: Record<string, unknown> | null = null;
          const nodeType = targetNode.type;
          const { assetType, fileUrl, fileType } = assetData;

          if (assetType === 'video' && nodeType === 'videoUpload') {
            updates = { videoServerPath: fileUrl, videoUrl: fileUrl, coverUrl: null, uploadStatus: 'done', videoName: assetData.name };
          } else if (assetType === 'pointcloud' && nodeType === 'gaussianSplat') {
            updates = {
              framePaths: [],
              sourcePlyUrl: fileUrl,
              splatUrl: null,
              gaussianCount: null,
              status: 'idle',
              progressText: null,
              progressStep: null,
              errorMessage: null,
              computeBackend: null,
              targetPlyType: null,
              currentTrainingIteration: null,
              maxTrainingIterations: null,
              activeTaskId: null,
              layerFiles: [],
              layerNames: [],
            };
          } else if (assetType === 'pointcloud' && nodeType === 'modelGeneration') {
            updates = { modelUrl: fileUrl, inputType: 'ply', outputUrl: fileUrl, outputType: 'ply', meshStatus: 'done' };
          } else if (assetType === 'splat' && nodeType === 'gaussianSplat') {
            updates = {
              framePaths: [],
              sourcePlyUrl: fileUrl,
              splatUrl: fileUrl,
              gaussianCount: null,
              status: 'done',
              progressText: null,
              progressStep: null,
              errorMessage: null,
              computeBackend: null,
              targetPlyType: null,
              currentTrainingIteration: null,
              maxTrainingIterations: null,
              activeTaskId: null,
              layerFiles: [],
              layerNames: [],
            };
          } else if (assetType === 'splat' && nodeType === 'modelGeneration') {
            updates = {
              modelUrl: fileUrl,
              inputType: 'splat',
              outputUrl: null,
              outputType: null,
              meshStatus: 'idle',
              errorMessage: null,
            };
          } else if (assetType === 'model' && nodeType === 'modelOrganize') {
            const isGlb = fileType === 'glb';
            updates = { modelUrl: fileUrl, outputUrl: fileUrl, outputType: isGlb ? 'glb' : 'obj' };
          } else if (assetType === 'model' && nodeType === 'modelSurface') {
            updates = { modelUrl: fileUrl };
          } else if (assetType === 'model' && nodeType === 'modelGeneration') {
            const isPly = fileType === 'ply';
            const isGlb = fileType === 'glb';
            const inferredType = isPly ? 'ply' : isGlb ? 'glb' : 'obj';
            updates = { modelUrl: fileUrl, inputType: inferredType, outputUrl: fileUrl, outputType: inferredType, meshStatus: 'done' };
          } else if (assetType === 'model' && nodeType === 'videoPreview') {
            updates = { modelUrl: fileUrl };
          }

          if (updates) {
            setNodes((nds) =>
              nds.map((n) =>
                n.id === targetNode.id
                  ? { ...n, data: { ...n.data, ...updates } }
                  : n
              )
            );
          }
        } catch {
          // Invalid asset data — ignore
        }
        return;
      }

      // --- Node drop: create a new node on the canvas ---
      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode: Node = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: defaultDataMap[type as NodeKind] || { label: type },
      };

      setNodes((nds) => [...nds, newNode]);
    },
    [screenToFlowPosition, setNodes, nodes, apiFetch]
  );

  /* ---- Handlers ---- */
  const handleRun = useCallback(() => {
    setWorkflowRunning(false);
    void apiFetch('/api/cancel-workflow-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .catch(() => {})
      .finally(() => {
        setWorkflowRunning(true);
      });
  }, [apiFetch]);

  const handleStop = useCallback(() => {
    setWorkflowRunning(false);
    void apiFetch('/api/cancel-workflow-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {});
  }, [apiFetch]);

  const handleClear = useCallback(() => {
    setWorkflowRunning(false);
    void apiFetch('/api/cancel-workflow-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {});
    setNodes((nds) =>
      nds.map((node) => ({
        ...node,
        selected: false,
        dragging: false,
        data: getClearedNodeData(node),
      }))
    );
    setCanvasRevision((value) => value + 1);
  }, [apiFetch, setNodes]);

  /* ---- Save / Load Workflow ---- */
  const handleSaveWorkflow = useCallback(async () => {
    try {
      // Strip runtime data, only save topology + position
      const cleanNodes = nodes.map((n) => {
        const defaultData = defaultDataMap[n.type as NodeKind] ?? {};
        if (n.type === 'stickyNote') {
          const d = n.data as Record<string, unknown>;
          return {
            id: n.id,
            type: n.type,
            position: n.position,
            data: {
              ...defaultData,
              label: typeof d.label === 'string' ? d.label : String(defaultData.label ?? 'Sticky Note'),
              text: typeof d.text === 'string' ? d.text : '',
            },
          };
        }
        return {
          id: n.id,
          type: n.type,
          position: n.position,
          data: { ...defaultData },
        };
      });
      const cleanEdges = edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
      }));

      const name = `Workflow ${new Date().toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-')}`;
      const res = await fetch('/api/workflow-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, nodes: cleanNodes, edges: cleanEdges }),
      });
      if (!res.ok) throw new Error('Save failed');
      // Trigger sidebar refresh
      window.dispatchEvent(new CustomEvent('workflow-library-changed'));
    } catch (err) {
      console.error('Failed to save workflow:', err);
    }
  }, [nodes, edges]);

  const handleLoadWorkflow = useCallback(
    (entry: { nodes: unknown[]; edges: unknown[] }) => {
      setWorkflowRunning(false);
      const loadedNodes = entry.nodes as Node[];
      const loadedEdges = entry.edges as Edge[];
      const filteredEdges = loadedEdges.filter((e) => {
        const src = loadedNodes.find((n) => n.id === e.source);
        const tgt = loadedNodes.find((n) => n.id === e.target);
        return src?.type !== 'stickyNote' && tgt?.type !== 'stickyNote';
      });
      setNodes(loadedNodes);
      setEdges(filteredEdges);
      setTimeout(() => fitView({ padding: 0.2 }), 100);
    },
    [setNodes, setEdges, fitView, setWorkflowRunning],
  );

  /* ---- Compute workflow progress for TopBar ---- */
  const pipelineNodes = getConnectedWorkflowNodes(nodes, edges);
  const workflowProgress = pipelineNodes.filter((n) => isNodeDone(n)).length;
  const workflowTotal = pipelineNodes.length;

  if (ephemeralSessionId === null) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Preparing workspace…
      </div>
    );
  }

  return (
    <WorkflowContext.Provider
      value={{ workflowRunning, setWorkflowRunning, ephemeralSessionId, apiFetch }}
    >
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950">
        {/* Top Bar */}
        <TopBar
          onRun={handleRun}
          onStop={handleStop}
          onClear={handleClear}
          onSaveWorkflow={handleSaveWorkflow}
          workflowRunning={workflowRunning}
          progress={{ done: workflowProgress, total: workflowTotal }}
        />

        <div className="relative flex-1 overflow-hidden">
          {/* Sidebar — absolute so it floats over the canvas */}
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
            onLoadWorkflow={handleLoadWorkflow}
          />

          {/* Canvas — always full width */}
          <div ref={reactFlowWrapper} className="h-full w-full">
            <ReactFlow
              key={canvasRevision}
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onDrop={onDrop}
              onDragOver={onDragOver}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={fitViewOptions}
              defaultEdgeOptions={defaultEdgeOptions}
              proOptions={proOptions}
              className="bg-zinc-950"
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="#27272a"
              />
              <Controls
                position="bottom-right"
                className="!rounded-lg !border-zinc-700 !bg-zinc-800 [&>button]:!border-zinc-700 [&>button]:!bg-zinc-800 [&>button]:!fill-zinc-300 [&>button:hover]:!bg-zinc-700"
              />
              <MiniMap
                position="bottom-left"
                className="!ml-16 !rounded-lg !border-zinc-700 !bg-zinc-900"
                maskColor="rgba(0,0,0,0.7)"
                nodeColor={getMinimapNodeColor}
              />
            </ReactFlow>
          </div>
        </div>
      </div>
    </WorkflowContext.Provider>
  );
}

/* ========== Flow Editor with Provider ========== */
export default function FlowEditor() {
  return (
    <ReactFlowProvider>
      <FlowEditorInner />
    </ReactFlowProvider>
  );
}
