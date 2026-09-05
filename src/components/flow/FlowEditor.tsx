'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ReactFlow,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  addEdge,
  getBezierPath,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  type OnConnect,
  BackgroundVariant,
} from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import '@xyflow/react/dist/style.css';

import Sidebar from './Sidebar';
import TopBar from './TopBar';
import {
  VideoUploadNode,
  FrameExtractionNode,
  ModelOrganizeNode,
  VideoPreviewNode,
  ComfyVideoNode,
  ModelSurfaceNode,
  ModelGenerationNode,
  GaussianSplatNode,
  StickyNoteNode,
} from './custom-nodes';
import { WorkflowContext } from '@/lib/workflow-context';
import { workflowApiFetch } from '@/lib/workflow-api-fetch';
import { getNodeVisualTheme } from '@/lib/node-config';
import { initialEdges, initialNodes } from '@/lib/default-workflow';
import { buildClearedWorkflowGraph } from '@/lib/workflow-clear';
import { getPreferredGaussianMeshOutputHandle } from '@/lib/gaussian-output-routing';
import { buildAssetDropNodeUpdates } from '@/lib/asset-drop-mapping';
import { findDropTargetNode } from '@/lib/flow-node-hit-test';
import { createDefaultNodeData, getWorkflowNodeDefinition, isWorkflowNodeType } from '@/lib/workflow/node-registry';
import { migrateSavedWorkflow, SAVED_WORKFLOW_SCHEMA_VERSION } from '@/lib/workflow/migrations';
import { useWorkflowRunner } from '@/hooks/use-workflow-runner';

/* ========== Node Types Registry ========== */
const nodeTypes: NodeTypes = {
  videoUpload: VideoUploadNode,
  frameExtraction: FrameExtractionNode,
  gaussianSplat: GaussianSplatNode,
  modelOrganize: ModelOrganizeNode,
  comfyVideo: ComfyVideoNode,
  videoPreview: VideoPreviewNode,
  modelSurface: ModelSurfaceNode,
  modelGeneration: ModelGenerationNode,
  stickyNote: StickyNoteNode,
};

function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  style,
}: EdgeProps) {
  const { setEdges } = useReactFlow();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const stroke = typeof style?.stroke === 'string' ? style.stroke : '#7a4a55';
  const edgeStyle = {
    ...style,
    stroke: selected ? '#ef4444' : stroke,
    strokeWidth: selected ? 3 : style?.strokeWidth ?? 2,
  };

  const handleDelete = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setEdges((eds) => eds.filter((edge) => edge.id !== id));
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={edgeStyle}
        interactionWidth={18}
      />
      {selected ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Delete connection"
            title="Delete connection"
            className="nodrag nopan absolute z-20 flex h-6 w-6 items-center justify-center rounded-md border border-red-500/70 bg-red-950/90 text-red-200 shadow-lg shadow-red-950/40 transition-colors hover:bg-red-900 hover:text-white"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 18}px)`,
              pointerEvents: 'all',
            }}
            onClick={handleDelete}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <Trash2 size={12} />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const edgeTypes: EdgeTypes = {
  workflow: WorkflowEdge,
};

/* ========== Stable ReactFlow Configs (module-level to avoid re-renders) ========== */
const fitViewOptions = { padding: 0.2 };
const defaultEdgeOptions = {
  type: 'workflow' as const,
  animated: false,
  style: { strokeWidth: 2, strokeDasharray: '5 3' },
};
const proOptions = { hideAttribution: true };
const getMinimapNodeColor = (node: Node) => getNodeVisualTheme(node.type || '').accent;

function isWorkflowNodeDone(node: Node | undefined): boolean {
  if (!node) return false;
  return getWorkflowNodeDefinition(node.type)?.getCompletion(node).complete ?? false;
}

function getClearedNodeData(node: Node): Record<string, unknown> {
  if (!isWorkflowNodeType(node.type)) return { ...(node.data as Record<string, unknown>) };

  const cleared = createDefaultNodeData(node.type);
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
  // Frame handles → frame extraction node header color
  if (sourceHandle === 'output' && sourceNodeType === 'frameExtraction') return '#6b5f7a';
  // Model handles → 3DGS model generation node header color
  if (sourceHandle === 'splat-output') return '#6f5aa8';
  if (sourceHandle === 'mesh-output') return '#7a4a55';
  if (['ply-output', 'obj-output'].includes(sourceHandle)) return '#7a4a55';
  if (sourceHandle === 'output') return '#7a4a55';
  return '#7a4a55';
}

function getWorkflowEdgeStyle(sourceHandle: string | null | undefined, sourceNodeType?: string) {
  return {
    stroke: getEdgeColor(sourceHandle, sourceNodeType),
    strokeWidth: 2,
    strokeDasharray: '5 3',
  };
}

function normalizeWorkflowEdge(edge: Edge, nodes: Node[]): Edge {
  const sourceNode = nodes.find((node) => node.id === edge.source);
  return {
    ...edge,
    type: 'workflow',
    selected: false,
    style: {
      ...getWorkflowEdgeStyle(edge.sourceHandle, sourceNode?.type),
      ...(edge.style || {}),
    },
  };
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
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    initialEdges.map((edge) => normalizeWorkflowEdge(edge, initialNodes)),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [ephemeralSessionId, setEphemeralSessionId] = useState<string | null>(null);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView, getEdges } = useReactFlow();

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
  const workflowRunner = useWorkflowRunner({
    nodes,
    edges,
    setNodes,
    apiFetch,
    ephemeralSessionId,
  });

  /* ---- Connection ---- */
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (sourceNode?.type === 'stickyNote' || targetNode?.type === 'stickyNote') {
        return;
      }
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: 'workflow',
            animated: false,
            style: getWorkflowEdgeStyle(connection.sourceHandle, sourceNode?.type),
          },
          eds
        )
      );
    },
    [setEdges, nodes]
  );

  const onEdgeClick = useCallback((event: ReactMouseEvent, edge: Edge) => {
    event.stopPropagation();
    setEdges((eds) => eds.map((candidate) => ({ ...candidate, selected: candidate.id === edge.id })));
  }, [setEdges]);

  const onPaneClick = useCallback(() => {
    setEdges((eds) => eds.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)));
  }, [setEdges]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        const tagName = activeElement.tagName.toLowerCase();
        const isEditable =
          tagName === 'input' ||
          tagName === 'textarea' ||
          tagName === 'select' ||
          activeElement.isContentEditable;
        if (isEditable) return;
      }

      const selectedEdgeIds = new Set(getEdges().filter((edge) => edge.selected).map((edge) => edge.id));
      if (selectedEdgeIds.size === 0) return;
      event.preventDefault();
      setEdges((eds) => eds.filter((edge) => !selectedEdgeIds.has(edge.id)));
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [getEdges, setEdges]);

  /* ---- Edge animation: animate when source is done and target is not yet done ---- */
  useEffect(() => {
    setEdges((eds) =>
      eds.map((edge) => {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        const targetNode = nodes.find((n) => n.id === edge.target);

        const sourceDone = isWorkflowNodeDone(sourceNode);
        const targetDone = isWorkflowNodeDone(targetNode);

        const shouldAnimate = sourceDone && !targetDone;

        if (edge.animated === shouldAnimate) return edge;

        return { ...edge, animated: shouldAnimate };
      })
    );
  }, [nodes, setEdges]);

  /* ---- Gaussian Splat → Mesh Gen output routing ---- */
  useEffect(() => {
    setEdges((eds) => {
      let changed = false;
      const nextEdges = eds.map((edge) => {
        const sourceNode = nodes.find((node) => node.id === edge.source);
        const targetNode = nodes.find((node) => node.id === edge.target);
        const isGaussianToMesh =
          sourceNode?.type === 'gaussianSplat' &&
          targetNode?.type === 'modelGeneration' &&
          edge.targetHandle === 'model-input' &&
          (edge.sourceHandle === 'splat-output' || edge.sourceHandle === 'mesh-output');

        if (!isGaussianToMesh || sourceNode.data.status === 'processing') {
          return edge;
        }

        const preferredHandle = getPreferredGaussianMeshOutputHandle(sourceNode.data);
        if (edge.sourceHandle === preferredHandle) {
          return edge;
        }

        changed = true;
        return {
          ...edge,
          sourceHandle: preferredHandle,
          style: {
            ...(edge.style || {}),
            ...getWorkflowEdgeStyle(preferredHandle, sourceNode.type),
          },
        };
      });

      return changed ? nextEdges : eds;
    });
  }, [nodes, setEdges]);

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

          // Find the node under the drop position using actual React Flow measurements.
          const targetNode = findDropTargetNode(nodes, flowPos);

          if (!targetNode) return;

          const updates = buildAssetDropNodeUpdates(assetData, targetNode.type);

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
      if (!isWorkflowNodeType(type)) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode: Node = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: createDefaultNodeData(type),
      };

      setNodes((nds) => [...nds, newNode]);
    },
    [screenToFlowPosition, setNodes, nodes]
  );

  /* ---- Handlers ---- */
  const handleRun = useCallback(() => {
    workflowRunner.run();
  }, [workflowRunner]);

  const handleStop = useCallback(() => {
    workflowRunner.stop();
  }, [workflowRunner]);

  const handleClear = useCallback(() => {
    workflowRunner.stop();
    const cleared = buildClearedWorkflowGraph(nodes, edges, getClearedNodeData);
    setNodes(cleared.nodes);
    setEdges(cleared.edges);
    setCanvasRevision((value) => value + 1);
  }, [edges, nodes, setEdges, setNodes, workflowRunner]);

  /* ---- Save / Load Workflow ---- */
  const handleSaveWorkflow = useCallback(async () => {
    try {
      // Strip runtime data, only save topology + position
      const cleanNodes = nodes.map((n) => {
        const defaultData = isWorkflowNodeType(n.type) ? createDefaultNodeData(n.type) : {};
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
        body: JSON.stringify({ schemaVersion: SAVED_WORKFLOW_SCHEMA_VERSION, name, nodes: cleanNodes, edges: cleanEdges }),
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
      workflowRunner.stop();
      const migrated = migrateSavedWorkflow(entry);
      setNodes(migrated.nodes);
      setEdges(migrated.edges.map((edge) => normalizeWorkflowEdge(edge, migrated.nodes)));
      setTimeout(() => fitView({ padding: 0.2 }), 100);
    },
    [setNodes, setEdges, fitView, workflowRunner],
  );

  if (ephemeralSessionId === null) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Preparing workspace…
      </div>
    );
  }

  return (
    <WorkflowContext.Provider
      value={{
        workflowRunning: false,
        setWorkflowRunning: () => {},
        runSingleNode: workflowRunner.runSingleNode,
        ephemeralSessionId,
        apiFetch,
      }}
    >
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950">
        {/* Top Bar */}
        <TopBar
          onRun={handleRun}
          onStop={handleStop}
          onClear={handleClear}
          onSaveWorkflow={handleSaveWorkflow}
          workflowRunning={workflowRunner.workflowRunning}
          progress={workflowRunner.progress}
          runError={workflowRunner.error}
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
              onEdgeClick={onEdgeClick}
              onPaneClick={onPaneClick}
              onConnect={onConnect}
              onDrop={onDrop}
              onDragOver={onDragOver}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={fitViewOptions}
              defaultEdgeOptions={defaultEdgeOptions}
              deleteKeyCode={null}
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
