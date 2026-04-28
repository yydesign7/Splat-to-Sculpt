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
  PointCloudNode,
  MaterialNode,
  ModelOrganizeNode,
  VideoPreviewNode,
  ModelSurfaceNode,
  ModelGenerationNode,
  StickyNoteNode,
} from './custom-nodes';
import { WorkflowContext } from '@/lib/workflow-context';
import { workflowApiFetch } from '@/lib/workflow-api-fetch';
import { ingestPlyToPointCloudNode } from '@/lib/ingest-ply-to-point-cloud-node';
import { computeDownstreamPushes, isNodeDone } from '@/lib/workflow-engine';

/* ========== Node Types Registry ========== */
const nodeTypes: NodeTypes = {
  videoUpload: VideoUploadNode,
  frameExtraction: FrameExtractionNode,
  pointCloud: PointCloudNode,
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
const minimapNodeColorMap: Record<string, string> = {
  videoUpload: '#4a6a8a',
  frameExtraction: '#6b5f7a',
  pointCloud: '#4a7a74',
  material: '#7a6e4a',
  modelOrganize: '#5a6878',
  videoPreview: '#5a7a6a',
  modelSurface: '#5a7068',
  modelGeneration: '#7a4a55',
  stickyNote: '#a67c2a',
};
const getMinimapNodeColor = (node: Node) => minimapNodeColorMap[node.type || ''] || '#5a5870';

/* ========== Default Node Data Map ========== */
type NodeKind =
  | 'videoUpload'
  | 'frameExtraction'
  | 'pointCloud'
  | 'material'
  | 'modelOrganize'
  | 'videoPreview'
  | 'modelSurface'
  | 'modelGeneration'
  | 'stickyNote';

const defaultDataMap: Record<NodeKind, Record<string, unknown>> = {
  videoUpload: { label: 'Video Upload', videoUrl: null, coverUrl: null, videoName: null, videoServerPath: null, uploadStatus: 'idle', uploadError: null },
  frameExtraction: { label: 'Frame Extraction', videoServerPath: null, targetFrameCount: 120, frames: [], outputFolder: null, frameCount: 0, status: 'idle', errorMessage: null },
  pointCloud: { label: 'Point Cloud Gen', status: 'idle', pointCount: null, plyUrl: null, progressText: null, progressStep: null, errorMessage: null, enableDepthFusion: true, enableSegmentation: true, layerFiles: [], layerNames: [] },
  material: { label: 'Material Gen', status: 'idle', textureCount: null, textInput: '', textureUrl: null, errorMessage: null },
  modelOrganize: { label: 'Model Cleanup', modelUrl: null, outputUrl: null, outputType: null, isFullscreen: false, organizeStatus: 'idle', errorMessage: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  videoPreview: { label: 'Video Preview', videoUrl: null, videoName: null, modelUrl: null, videoGenerating: false, errorMessage: null, lightParams: null },
  modelSurface: { label: 'Surface Processing', materialFileName: null, materialPreviewUrl: null, modelUrl: null, outputModelUrl: null, outputModelType: null, selectedLayer: null, blenderProcessing: false, blenderError: null, materialParams: { base_color: [0.8, 0.75, 0.7], metallic: 0.0, roughness: 0.5, emissive_color: [0.0, 0.0, 0.0], emissive_strength: 0.0, alpha: 1.0, normal_scale: 1.0 }, renderUrl: null, layerParams: {}, lightParams: { ambientIntensity: 0.6, mainLightIntensity: 0.8, mainLightColor: [1, 1, 1], mainLightAzimuth: 45, mainLightElevation: 45, fillLightIntensity: 0.3, fillLightAzimuth: -135, fillLightElevation: 30, exposure: 1.0 }, layerFiles: [], layerNames: [], layerGlbUrls: [], layerUrlA: {}, layerUrlB: {}, layerUrlC: {} },
  modelGeneration: { label: '3DGS Model Gen', modelUrl: null, isFullscreen: false, inputType: null, outputUrl: null, outputType: null, textureUrl: null, meshStatus: 'idle', outputFormat: 'glb', errorMessage: null, faceCount: null, renderUrl: null, lightParams: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  stickyNote: { label: 'Sticky Note', text: '' },
};

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
  if (['ply-output', 'obj-output'].includes(sourceHandle)) return '#7a4a55';
  if (sourceHandle === 'output') return '#7a4a55';
  return '#7a4a55';
}

/* ========== Initial Nodes ========== */
const initialNodes: Node[] = [
  // Row 1: Main pipeline (material is placed above surface column, see id 5)
  {
    id: '1',
    type: 'videoUpload',
    position: { x: 50, y: 80 },
    data: { label: 'Video Upload', videoUrl: null, coverUrl: null, videoName: null, videoServerPath: null, uploadStatus: 'idle', uploadError: null },
  },
  {
    id: '2',
    type: 'frameExtraction',
    position: { x: 400, y: 80 },
    data: { label: 'Frame Extraction', videoServerPath: null, targetFrameCount: 120, frames: [], outputFolder: null, frameCount: 0, status: 'idle', errorMessage: null },
  },
  {
    id: '3',
    type: 'pointCloud',
    position: { x: 750, y: 80 },
    data: { label: 'Point Cloud Gen', status: 'idle', pointCount: null, plyUrl: null, progressText: null, progressStep: null, errorMessage: null },
  },
  {
    id: '4',
    type: 'modelGeneration',
    position: { x: 1100, y: 80 },
    data: { label: '3DGS Model Gen', modelUrl: null, isFullscreen: false, inputType: null, outputUrl: null, outputType: null, textureUrl: null, meshStatus: 'idle', outputFormat: 'glb', errorMessage: null, faceCount: null, renderUrl: null, lightParams: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  },
  // Material Gen: directly above surface (same x as id 7)
  {
    id: '5',
    type: 'material',
    position: { x: 1450, y: -260 },
    data: { label: 'Material Gen', status: 'idle', textureCount: null, textInput: '', textureUrl: null, errorMessage: null },
  },

  // Model cleanup: directly below first 3DGS (id 4, x=1100, y=80)
  {
    id: '10',
    type: 'modelOrganize',
    position: { x: 1100, y: 430 },
    data: { label: 'Model Cleanup', modelUrl: null, outputUrl: null, outputType: null, isFullscreen: false, organizeStatus: 'idle', errorMessage: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  },
  // Surface: top-aligned with first 3DGS model gen (id 4, y=80)
  {
    id: '7',
    type: 'modelSurface',
    position: { x: 1450, y: 80 },
    data: { label: 'Surface Processing', materialFileName: null, materialPreviewUrl: null, modelUrl: null, outputModelUrl: null, outputModelType: null, selectedLayer: null, blenderProcessing: false, blenderError: null, materialParams: { base_color: [0.8, 0.75, 0.7], metallic: 0.0, roughness: 0.5, emissive_color: [0.0, 0.0, 0.0], emissive_strength: 0.0, alpha: 1.0, normal_scale: 1.0 }, renderUrl: null, layerParams: {}, lightParams: { ambientIntensity: 0.6, mainLightIntensity: 0.8, mainLightColor: [1, 1, 1], mainLightAzimuth: 45, mainLightElevation: 45, fillLightIntensity: 0.3, fillLightAzimuth: -135, fillLightElevation: 30, exposure: 1.0 }, layerFiles: [], layerNames: [], layerGlbUrls: [], layerUrlA: {}, layerUrlB: {}, layerUrlC: {} },
  },
  // Second 3DGS: top-aligned with surface (y=80)
  {
    id: '8',
    type: 'modelGeneration',
    position: { x: 1800, y: 80 },
    data: { label: '3DGS Model Gen', modelUrl: null, isFullscreen: false, inputType: null, outputUrl: null, outputType: null, textureUrl: null, meshStatus: 'idle', outputFormat: 'glb', errorMessage: null, faceCount: null, renderUrl: null, lightParams: null, layerFiles: [], layerNames: [], layerGlbUrls: [] },
  },
  {
    id: '9',
    type: 'videoPreview',
    position: { x: 1800, y: 430 },
    data: { label: 'Video Preview', videoUrl: null, videoName: null, modelUrl: null, videoGenerating: false, errorMessage: null, lightParams: null },
  },
  {
    id: 'sn1',
    type: 'stickyNote',
    position: { x: 40, y: -220 },
    data: { label: 'Sticky Note', text: 'Drag nodes from the library (left) onto the canvas to build your pipeline.' },
  },
  {
    id: 'sn2',
    type: 'stickyNote',
    position: { x: 40, y: -60 },
    data: { label: 'Sticky Note', text: 'Notes are saved when you use Save → open Workflows in the sidebar.' },
  },
  {
    id: 'sn3',
    type: 'stickyNote',
    /* Centered above point cloud (id 3): x=750, width 280; sticky width 220 */
    position: { x: 780, y: -88 },
    data: { label: 'Sticky Note', text: '' },
  },
];

/* ========== Initial Edges ========== */
const initialEdges: Edge[] = [
  {
    id: 'e1-2',
    source: '1',
    sourceHandle: 'output',
    target: '2',
    targetHandle: 'input',
    type: 'default',
    animated: false,
    style: { stroke: '#4a6a8a', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e2-3',
    source: '2',
    sourceHandle: 'output',
    target: '3',
    targetHandle: 'input',
    type: 'default',
    animated: false,
    style: { stroke: '#6b5f7a', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e3-4',
    source: '3',
    sourceHandle: 'ply-output',
    target: '4',
    targetHandle: 'model-input',
    type: 'default',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e4-10',
    source: '4',
    sourceHandle: 'output',
    target: '10',
    targetHandle: 'obj-input',
    type: 'default',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e10-7',
    source: '10',
    sourceHandle: 'obj-output',
    target: '7',
    targetHandle: 'obj-input',
    type: 'default',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e7-8',
    source: '7',
    sourceHandle: 'obj-output',
    target: '8',
    targetHandle: 'model-input',
    type: 'default',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
  {
    id: 'e7-9',
    source: '7',
    sourceHandle: 'obj-output',
    target: '9',
    targetHandle: 'obj-input',
    type: 'default',
    animated: false,
    style: { stroke: '#7a4a55', strokeWidth: 2, strokeDasharray: '5 3' },
  },
];

/* ========== Flow Editor Inner ========== */
const EPHEMERAL_SESSION_STORAGE_KEY = 'wf_ephemeral_session_id';

function FlowEditorInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [ephemeralSessionId, setEphemeralSessionId] = useState<string | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const prev = typeof window !== 'undefined' ? sessionStorage.getItem(EPHEMERAL_SESSION_STORAGE_KEY) : null;
      if (prev) {
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

      const pushes = computeDownstreamPushes(node, edges);
      for (const push of pushes) {
        // Only push if the target node doesn't already have the data
        const targetNode = nodes.find((n) => n.id === push.targetNodeId);
        if (!targetNode) continue;

        // Check if any field in the update is different from current data
        const hasNewData = Object.entries(push.updates).some(
          ([key, value]) => targetNode.data[key] !== value
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
        return { ...n, data: { ...n.data, ...updatesForNode } };
      })
    );
  }, [nodes, edges, workflowRunning, setNodes]);

  /* ---- Auto-stop workflow when all nodes are done or errored ---- */
  useEffect(() => {
    if (!workflowRunning) return;

    const allSettled = nodes.every((n) => {
      if (n.type === 'videoPreview') return true; // Terminal node, always settled
      return isNodeDone(n);
    });

    // Don't auto-stop — let the user stop manually or keep watching
    // The workflow stays "running" until user clicks stop
  }, [nodes, workflowRunning]);

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
          } else if (assetType === 'pointcloud' && nodeType === 'pointCloud') {
            const targetId = targetNode.id;
            const enableSeg =
              (targetNode.data as { enableSegmentation?: boolean }).enableSegmentation !== false;

            setNodes((nds) =>
              nds.map((n) =>
                n.id === targetId
                  ? {
                      ...n,
                      data: {
                        ...n.data,
                        status: 'processing',
                        plyUrl: null,
                        pointCount: null,
                        progressText: 'Loading asset…',
                        errorMessage: null,
                        layerFiles: [],
                        layerNames: [],
                        progressStep: null,
                      },
                    }
                  : n
              )
            );

            void (async () => {
              try {
                const absUrl = new URL(assetData.fileUrl, window.location.origin).href;
                const fetchRes = await fetch(absUrl);
                if (!fetchRes.ok) {
                  throw new Error(`Failed to fetch asset (HTTP ${fetchRes.status})`);
                }
                const blob = await fetchRes.blob();

                const r = await ingestPlyToPointCloudNode({
                  apiFetch,
                  file: blob,
                  fileLabel: assetData.name || 'asset.ply',
                  enableSegmentation: enableSeg,
                  onUploadComplete: enableSeg
                    ? async ({ plyUrl: pu, pointCount: pc }) => {
                        setNodes((nds) =>
                          nds.map((n) =>
                            n.id === targetId
                              ? {
                                  ...n,
                                  data: {
                                    ...n.data,
                                    plyUrl: pu,
                                    pointCount: pc,
                                    progressText: 'Segmenting…',
                                  },
                                }
                              : n
                          )
                        );
                      }
                    : undefined,
                });

                if (!r.ok) {
                  setNodes((nds) =>
                    nds.map((n) =>
                      n.id === targetId
                        ? {
                            ...n,
                            data: {
                              ...n.data,
                              status: 'error',
                              errorMessage: r.errorMessage,
                              progressText: null,
                            },
                          }
                        : n
                    )
                  );
                  return;
                }

                setNodes((nds) =>
                  nds.map((n) =>
                    n.id === targetId
                      ? {
                          ...n,
                          data: {
                            ...n.data,
                            status: 'done',
                            plyUrl: r.plyUrl,
                            pointCount: r.pointCount,
                            layerFiles: r.layerFiles,
                            layerNames: r.layerNames,
                            progressText: null,
                            progressStep: null,
                            errorMessage: null,
                          },
                        }
                      : n
                  )
                );
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : 'Failed to load asset';
                setNodes((nds) =>
                  nds.map((n) =>
                    n.id === targetId
                      ? {
                          ...n,
                          data: {
                            ...n.data,
                            status: 'error',
                            errorMessage: message,
                            progressText: null,
                          },
                        }
                      : n
                  )
                );
              }
            })();
            return;
          } else if (assetType === 'pointcloud' && nodeType === 'modelGeneration') {
            updates = { modelUrl: fileUrl, inputType: 'ply', outputUrl: fileUrl, outputType: 'ply', meshStatus: 'done' };
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
    setWorkflowRunning(true);
  }, []);

  const handleStop = useCallback(() => {
    setWorkflowRunning(false);
  }, []);

  const handleReset = useCallback(() => {
    setWorkflowRunning(false);
    setNodes(initialNodes);
    setEdges(initialEdges);
    setTimeout(() => fitView({ padding: 0.2 }), 100);
  }, [setNodes, setEdges, fitView]);

  const handleFitView = useCallback(() => {
    fitView({ padding: 0.2, duration: 300 });
  }, [fitView]);

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
  const pipelineNodes = nodes.filter((n) => n.type !== 'stickyNote');
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
          onReset={handleReset}
          onFitView={handleFitView}
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
                className="!rounded-lg !border-zinc-700 !bg-zinc-900"
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
