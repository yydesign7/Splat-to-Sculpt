'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react';
import { X, Upload, FolderOpen, Maximize2, MonitorPlay, Layers, Video, Film, Palette, Box, Check, RotateCcw, StickyNote, Download, Sparkles, Orbit, Brush, Eraser } from 'lucide-react';
import { getNodeConfig, getNodeVisualTheme, NODE_WIDTH, VIDEO_PREVIEW_NODE_WIDTH } from '@/lib/node-config';
import { mergeLayerGlbsInBrowser, isGltfLikeUrl, type LayerGlbEntry } from '@/lib/browser-merge-glb';
import { inferModelTypeFromUrl as inferModelType } from '@/lib/infer-model-type-from-url';
import { useWorkflow } from '@/lib/workflow-context';
import dynamic from 'next/dynamic';
import { DynamicPreviewImage } from './DynamicPreviewImage';

/** Record a model generation event to the history API */
async function recordModelHistory(params: {
  name: string;
  modelUrl: string | null;
  modelType: string | null;
  thumbnailUrl?: string | null;
  sourceNode: string;
}) {
  try {
    await fetch('/api/model-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch {
    // Silently fail — history is non-critical
  }
}

type AssetType = 'video' | 'pointcloud' | 'splat' | 'model' | 'render-video';
type GaussianDeviceType = 'cuda' | 'mps' | 'cpu';
type GaussianTrainingMode = 'auto' | 'train';

function normalizeGaussianDeviceType(value: unknown): GaussianDeviceType | null {
  return value === 'cuda' || value === 'mps' || value === 'cpu' ? value : null;
}

function normalizeGaussianTrainingMode(value: unknown): GaussianTrainingMode {
  return value === 'train' ? 'train' : 'auto';
}

function getGaussianTargetPlyLabel(deviceType: GaussianDeviceType | null, trainingMode: GaussianTrainingMode) {
  if (deviceType === 'cuda' || trainingMode === 'train') return 'trained 3DGS PLY';
  if (deviceType === 'mps' || deviceType === 'cpu') return 'initializer splat PLY';
  return '3DGS PLY';
}

async function recordAsset(params: {
  name: string;
  assetType: AssetType;
  fileUrl: string;
  fileType: string;
  thumbnailUrl?: string | null;
  sourceNode: string;
}) {
  try {
    await fetch('/api/asset-library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch {
    // Silently fail — asset recording is non-critical
  }
}

async function createAssetThumbnail(params: {
  fileUrl: string;
  ephemeralSessionId: string | null;
}): Promise<string | null> {
  if (!params.ephemeralSessionId) return null;
  try {
    const res = await fetch('/api/generate-asset-thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    return data.success && typeof data.thumbnailUrl === 'string' ? data.thumbnailUrl : null;
  } catch {
    return null;
  }
}

function drawCroppedImageToCanvas(
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
) {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx || sourceWidth <= 0 || sourceHeight <= 0) return null;

  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }

  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
  return canvas;
}

/** Poll /api/mesh-status until a generate-mesh task finishes */
async function waitForMeshTask(
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ meshUrl: string; meshFormat: string; faceCount: number }> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const r = await fetchImpl(`/api/mesh-status?taskId=${encodeURIComponent(taskId)}`);
    const task = await r.json();
    if (task.status === 'done' && task.result) {
      return {
        meshUrl: task.result.meshUrl,
        meshFormat: task.result.meshFormat,
        faceCount: task.result.faceCount ?? 0,
      };
    }
    if (task.status === 'error') throw new Error(task.error || 'Mesh generation failed');
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('Mesh task timeout');
}

/** Poll /api/gaussian-status until a generate-gaussian-splat task finishes */
async function waitForGaussianTask(
  taskId: string,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (task: {
    progress?: string;
    progressStep?: number;
    deviceType?: GaussianDeviceType;
    computeBackend?: string;
    trainingMode?: GaussianTrainingMode;
    targetPlyType?: string;
    trueTrainingAvailable?: boolean;
    trueTrainingUnavailableReason?: string;
    currentTrainingIteration?: number;
    maxTrainingIterations?: number;
  }) => void,
): Promise<{ splatUrl: string; sourcePlyUrl: string; gaussianCount: number; format: '3dgs-ply'; layerFiles?: string[]; layerNames?: string[]; deviceType?: GaussianDeviceType; computeBackend?: string; trainingMode?: GaussianTrainingMode; targetPlyType?: string }> {
  for (let attempt = 0; attempt < 240; attempt++) {
    const r = await fetchImpl(`/api/gaussian-status?taskId=${encodeURIComponent(taskId)}`);
    const task = await r.json();
    if (task.status === 'processing') {
      onProgress?.({
        progress: task.progress,
        progressStep: typeof task.progressStep === 'number' ? task.progressStep : undefined,
        deviceType: normalizeGaussianDeviceType(task.deviceType) ?? undefined,
        computeBackend: typeof task.computeBackend === 'string' ? task.computeBackend : undefined,
        trainingMode: normalizeGaussianTrainingMode(task.trainingMode),
        targetPlyType: typeof task.targetPlyType === 'string' ? task.targetPlyType : undefined,
        trueTrainingAvailable:
          typeof task.trueTrainingAvailable === 'boolean' ? task.trueTrainingAvailable : undefined,
        trueTrainingUnavailableReason:
          typeof task.trueTrainingUnavailableReason === 'string' ? task.trueTrainingUnavailableReason : undefined,
        currentTrainingIteration:
          typeof task.currentTrainingIteration === 'number' ? task.currentTrainingIteration : undefined,
        maxTrainingIterations:
          typeof task.maxTrainingIterations === 'number' ? task.maxTrainingIterations : undefined,
      });
    }
    if (task.status === 'done' && task.result) {
      return {
        ...task.result,
        deviceType: normalizeGaussianDeviceType(task.deviceType) ?? undefined,
        trainingMode: normalizeGaussianTrainingMode(task.trainingMode),
        targetPlyType: typeof task.targetPlyType === 'string' ? task.targetPlyType : undefined,
      };
    }
    if (task.status === 'cancelled') throw new Error('Gaussian splat generation stopped');
    if (task.status === 'error') throw new Error(task.error || 'Gaussian splat generation failed');
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('Gaussian splat task timeout');
}

function sanitizeLabelForFilename(label: string): string {
  const base = (label || 'export')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 80);
  return base || 'export';
}

function previewDownloadNumericSuffix(nodeId: string): string {
  if (/^\d+$/.test(nodeId)) return nodeId;
  return String(Date.now());
}

function extFromPathname(url: string, fallback: string): string {
  const fb = fallback.startsWith('.') ? fallback : `.${fallback}`;
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (m) return `.${m[1].toLowerCase()}`;
  } catch {
    /* ignore */
  }
  return fb;
}

function buildPreviewDownloadFilename(label: string | undefined, nodeId: string, ext: string): string {
  const safe = sanitizeLabelForFilename(String(label ?? 'Node'));
  const num = previewDownloadNumericSuffix(nodeId);
  const dotExt = ext.startsWith('.') ? ext : `.${ext}`;
  return `${safe}_${num}${dotExt}`;
}

async function downloadFromUrl(url: string, filename: string): Promise<void> {
  if (url.startsWith('blob:')) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const obj = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = obj;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(obj);
}

function PreviewDownloadIconButton({ onClick }: { onClick: (e: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      type="button"
      title="Download"
      className="nodrag nopan absolute right-1.5 bottom-1.5 z-20 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-zinc-200 transition-colors hover:bg-black/80"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
    >
      <Download size={14} />
    </button>
  );
}

function PreviewClearIconButton({ onClick }: { onClick: (e: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      type="button"
      title="Clear file"
      aria-label="Clear file"
      className="nodrag nopan absolute right-1.5 top-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-zinc-300 transition-colors hover:bg-black/80 hover:text-white"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
    >
      <X size={12} />
    </button>
  );
}

const ModelViewer = dynamic(() => import('./ModelViewer'), { ssr: false });
const SplatViewer = dynamic(() => import('./SplatViewer'), { ssr: false });
const InteractiveModelViewer = dynamic(() => import('./InteractiveModelViewer'), { ssr: false });
import { LightControls } from './LightControls';

/* ========== Shared Helpers ========== */

/** Delayed revoke for blobs not tied to InteractiveModelViewer success (cache bust, layer C, Clear, etc.). */
const PREVIEW_BLOB_REVOKE_DELAY_MS = 12000;

/* ========== Shared Types ========== */
type VideoUploadNodeData = Node<{
  label: string;
  videoUrl: string | null;
  coverUrl: string | null;
  videoName: string | null;
  videoServerPath: string | null;
  uploadStatus: 'idle' | 'uploading' | 'done' | 'error';
  uploadError: string | null;
  /** Number of frames to extract (used by downstream Frame Extraction). */
  targetFrameCount: number;
}>;

type FrameExtractionNodeData = Node<{
  label: string;
  videoServerPath: string | null;
  targetFrameCount: number;
  frames: string[];
  outputFolder: string | null;
  frameCount: number;
  status: 'idle' | 'extracting' | 'done' | 'error';
  errorMessage: string | null;
}>;

type GaussianSplatNodeData = Node<{
  label: string;
  framePaths: string[];
  sourcePlyUrl: string | null;
  splatUrl: string | null;
  gaussianCount: number | null;
  status: 'idle' | 'processing' | 'done' | 'error';
  progressText: string | null;
  progressStep: number | null;
  errorMessage: string | null;
  trainingIterations: number;
  currentTrainingIteration: number | null;
  maxTrainingIterations: number | null;
  activeTaskId: string | null;
  deviceType: GaussianDeviceType | null;
  computeBackend: string | null;
  trainingMode: GaussianTrainingMode;
  targetPlyType: string | null;
  trueTrainingAvailable?: boolean | null;
  trueTrainingUnavailableReason?: string | null;
  enableFastSegmentation?: boolean;
  layerFiles: string[];
  layerNames: string[];
}>;

type MaterialNodeData = Node<{
  label: string;
  status: 'idle' | 'processing' | 'done' | 'error';
  textureCount: number | null;
  textInput: string;
  textureUrl: string | null;
  errorMessage: string | null;
}>;

type ModelOrganizeNodeData = Node<{
  label: string;
  modelUrl: string | null;
  outputUrl: string | null;
  outputType: 'glb' | 'fbx' | 'obj' | 'ply' | null;
  isFullscreen: boolean;
  organizeStatus: 'idle' | 'organizing' | 'done' | 'error';
  errorMessage: string | null;
  layerFiles: string[];
  layerNames: string[];
  /** When set, cleanup runs one Blender job per entry (same order as layerNames). */
  layerGlbUrls: string[];
}>;

type VideoPreviewNodeData = Node<{
  label: string;
  videoUrl: string | null;
  videoName: string | null;
  modelUrl: string | null;
  videoGenerating: boolean;
  errorMessage: string | null;
  lightParams: LightParams | null;
}>;

/** Principled BSDF material parameters matching Blender's node */
export interface MaterialParams {
  base_color: [number, number, number];   // 0-1 RGB
  metallic: number;                        // 0-1
  roughness: number;                       // 0-1
  emissive_color: [number, number, number]; // 0-1 RGB
  emissive_strength: number;               // 0-10
  alpha: number;                           // 0-1
  normal_scale: number;                    // 0-5
  base_color_modified: boolean;            // whether user explicitly changed base_color
}

const DEFAULT_MATERIAL_PARAMS: MaterialParams = {
  base_color: [0.8, 0.75, 0.7],
  metallic: 0.0,
  roughness: 0.5,
  emissive_color: [0.0, 0.0, 0.0],
  emissive_strength: 0.0,
  alpha: 1.0,
  normal_scale: 1.0,
  base_color_modified: false,
};

/** Light parameters for 3D preview and video rendering */
export interface LightParams {
  ambientIntensity: number;                // 0-3, default 0.6
  mainLightIntensity: number;              // 0-10, default 0.8
  mainLightColor: [number, number, number]; // 0-1 RGB, default [1,1,1]
  mainLightAzimuth: number;                // 0-360° azimuth (around Y, 0=front)
  mainLightElevation: number;              // 0-90° elevation (0=horizontal, 90=overhead)
  fillLightIntensity: number;              // 0-5, default 0.3
  fillLightAzimuth: number;                // 0-360° fill light azimuth
  fillLightElevation: number;              // 0-90° fill light elevation
  exposure: number;                        // 0.1-3, default 1.0
}

export const DEFAULT_LIGHT_PARAMS: LightParams = {
  ambientIntensity: 0.6,
  mainLightIntensity: 0.8,
  mainLightColor: [1, 1, 1],
  mainLightAzimuth: 45,
  mainLightElevation: 45,
  fillLightIntensity: 0.3,
  fillLightAzimuth: 225,
  fillLightElevation: 30,
  exposure: 1.0,
};

const LAYER_BLENDER_DEBOUNCE_MS = 500;

function buildLayerUrlMap(layerGlbUrls: string[], layerNames: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  layerGlbUrls.forEach((url, i) => {
    const name = layerNames[i] || `layer_${i}`;
    m[name] = url;
  });
  return m;
}

function orderedLayerGlbEntries(
  layerGlbUrls: string[],
  layerNames: string[],
  layerUrlA: Record<string, string>,
): LayerGlbEntry[] {
  const urlA =
    Object.keys(layerUrlA).length > 0 ? layerUrlA : buildLayerUrlMap(layerGlbUrls, layerNames);
  const order =
    layerNames.length > 0
      ? layerNames.filter((n) => urlA[n])
      : Object.keys(urlA).sort();
  return order.map((layerName) => ({ layerName, url: urlA[layerName] }));
}

/** Browser merge preview: prefer Blender per-layer GLB (url_b), else url_a — mirrors sendToBlender mergePaths. */
function orderedLayerPreviewGlbEntries(
  layerGlbUrls: string[],
  layerNames: string[],
  layerUrlA: Record<string, string>,
  layerUrlB: Record<string, string>,
): LayerGlbEntry[] {
  const urlA =
    Object.keys(layerUrlA).length > 0 ? layerUrlA : buildLayerUrlMap(layerGlbUrls, layerNames);
  const order =
    layerNames.length > 0
      ? layerNames.filter((n) => !!(layerUrlB[n] || urlA[n]))
      : [...new Set([...Object.keys(urlA), ...Object.keys(layerUrlB)])].sort();
  return order
    .map((layerName) => {
      const url = layerUrlB[layerName] || urlA[layerName];
      return url ? { layerName, url } : null;
    })
    .filter((e): e is LayerGlbEntry => e !== null);
}

type ModelSurfaceNodeData = Node<{
  label: string;
  materialFileName: string | null;
  materialPreviewUrl: string | null;
  modelUrl: string | null;
  outputModelUrl: string | null;
  outputModelType: 'glb' | 'fbx' | 'obj' | 'ply' | null;
  selectedLayer: string | null;
  blenderProcessing: boolean;
  blenderError: string | null;
  materialParams: MaterialParams;
  renderUrl: string | null;
  layerParams: Record<string, MaterialParams>;  // per-layer params
  lightParams: LightParams;
  layerFiles: string[];  // PLY layer file paths from point cloud segmentation
  layerNames: string[];  // Layer names from segmentation metadata
  /** One GLB per layer (order matches layerNames); from 3DGS or cleanup. */
  layerGlbUrls: string[];
  /** Per-layer original GLB URLs (url_a), keyed by layer name. */
  layerUrlA: Record<string, string>;
  /** Per-layer Blender output GLB URLs (url_b), keyed by layer name. */
  layerUrlB: Record<string, string>;
  /** Reserved for per-layer cached highlight-merge blob URLs (url_c); preview cache uses in-memory ref. */
  layerUrlC: Record<string, string>;
}>;

type ModelGenerationNodeData = Node<{
  label: string;
  modelUrl: string | null;
  isFullscreen: boolean;
  outputUrl: string | null;
  outputType: 'glb' | 'fbx' | 'obj' | 'ply' | 'splat' | null;
  inputType: 'ply' | 'obj' | 'glb' | 'splat' | null;
  textureUrl: string | null;
  meshStatus: 'idle' | 'processing' | 'done' | 'error';
  outputFormat: 'glb' | 'obj' | 'ply';
  errorMessage: string | null;
  faceCount: number | null;
  gaussianCount: number | null;
  computeBackend: string | null;
  renderUrl: string | null;
  lightParams: LightParams | null;
  layerFiles: string[];
  layerNames: string[];
  layerGlbUrls: string[];
}>;

type StickyNoteNodeData = Node<{
  label: string;
  text: string;
}>;

/* ========== Node Header Icon Map ========== */
const HEADER_ICONS: Record<string, React.ReactNode> = {
  videoUpload: <Video size={14} />,
  frameExtraction: <Film size={14} />,
  gaussianSplat: <Orbit size={14} />,
  material: <Palette size={14} />,
  modelOrganize: <Eraser size={14} />,
  videoPreview: <MonitorPlay size={14} />,
  modelSurface: <Brush size={14} />,
  modelGeneration: <Box size={14} />,
  stickyNote: <StickyNote size={14} />,
};

type NodeVisualStatus = 'idle' | 'processing' | 'extracting' | 'done' | 'error';

const BASE_NODE_SHADOW = '0 10px 15px -3px rgb(0 0 0 / 0.34), 0 4px 6px -4px rgb(0 0 0 / 0.34)';
const BASE_NODE_BORDER = 'rgb(63 63 70)';
const NODE_FRAME_CLASS_NAME = 'relative rounded-lg border bg-zinc-800 shadow-lg transition-[border-color,box-shadow] duration-200';

const NODE_STATUS_STYLES: Record<NodeVisualStatus, { border: string; dot: string; shadow: string }> = {
  idle: {
    border: BASE_NODE_BORDER,
    dot: '#71717a',
    shadow: BASE_NODE_SHADOW,
  },
  processing: {
    border: BASE_NODE_BORDER,
    dot: '#eab308',
    shadow: BASE_NODE_SHADOW,
  },
  extracting: {
    border: BASE_NODE_BORDER,
    dot: '#eab308',
    shadow: BASE_NODE_SHADOW,
  },
  done: {
    border: BASE_NODE_BORDER,
    dot: '#22c55e',
    shadow: BASE_NODE_SHADOW,
  },
  error: {
    border: BASE_NODE_BORDER,
    dot: '#f87171',
    shadow: BASE_NODE_SHADOW,
  },
};

function getNodeFrameStyle(type: string, status: NodeVisualStatus, width = NODE_WIDTH): CSSProperties {
  const theme = getNodeVisualTheme(type);
  const state = NODE_STATUS_STYLES[status] ?? NODE_STATUS_STYLES.idle;

  return {
    width,
    borderColor: state.border,
    boxShadow: state.shadow,
    '--node-accent': theme.accent,
    '--node-accent-soft': theme.accentSoft,
    '--node-accent-muted': theme.accentMuted,
    '--node-accent-text': theme.text,
    '--node-status-dot': state.dot,
  } as CSSProperties;
}

/* ========== Node Header ========== */
function NodeHeader({
  type,
  onDelete,
}: {
  type: string;
  onDelete: () => void;
}) {
  const config = getNodeConfig(type);
  if (!config) return null;
  const theme = getNodeVisualTheme(type);

  if (type === 'stickyNote') {
    return (
      <div
        className="flex items-center justify-between rounded-t-lg border-b border-amber-700/50 px-3 py-2"
        style={{ backgroundColor: theme.accent }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/20 bg-black/10 text-amber-50">
            {HEADER_ICONS[type]}
          </span>
          <span className="truncate text-xs font-semibold text-amber-50">{config.label}</span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="flex h-5 w-5 items-center justify-center rounded-full text-amber-50/80 transition-colors hover:bg-white/15 hover:text-white"
          aria-label={`Delete ${config.label}`}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex items-center justify-between rounded-t-lg border-b border-zinc-700/80 bg-zinc-900/90 px-3 py-2">
      <span
        className="absolute left-0 top-0 h-full w-1 rounded-tl-lg"
        style={{ backgroundColor: theme.accent }}
      />
      <div className="flex min-w-0 items-center gap-2 pl-1">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
          style={{
            backgroundColor: theme.accentSoft,
            borderColor: theme.accentMuted,
            color: theme.text,
          }}
        >
          {HEADER_ICONS[type]}
        </span>
        <span className="truncate text-xs font-semibold text-zinc-100">{config.label}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: 'var(--node-status-dot, #71717a)' }}
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
          aria-label={`Delete ${config.label}`}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

/* ========== Handle Bar ========== */
interface PortDef {
  type: 'target' | 'source';
  id: string;
  label: string;
  color: string;
}

function HandleBar({ ports, children }: { ports: PortDef[]; children?: React.ReactNode }) {
  const targets = ports.filter((p) => p.type === 'target');
  const sources = ports.filter((p) => p.type === 'source');

  if (targets.length === 0 && sources.length === 0 && !children) return null;

  // Row height for each handle+label pair; vertical padding top+bottom
  const ROW_H = 20;
  const PAD = 4;
  const handleRows = Math.max(targets.length, sources.length, 1);
  const barHeight = PAD * 2 + handleRows * ROW_H;

  // Compute the vertical center of row i (used for both Handle top and label center)
  const rowCenter = (i: number) => PAD + i * ROW_H + ROW_H / 2;

  return (
    <div
      className="relative flex border-b border-zinc-700 bg-zinc-900/60"
      style={{ height: barHeight }}
    >
      {children && (
        <div className="absolute inset-y-0 left-2.5 right-12 z-10 flex items-center">
          {children}
        </div>
      )}
      {/* Absolute-positioned target handles — left edge */}
      {targets.map((p, i) => (
        <Handle
          key={p.id}
          type="target"
          position={Position.Left}
          id={p.id}
          className="!w-2.5 !h-2.5 !border-2 !border-zinc-800"
          style={{
            backgroundColor: p.color,
            top: rowCenter(i),
            transform: 'translateY(-50%)',
          }}
        />
      ))}
      {/* Absolute-positioned source handles — right edge */}
      {sources.map((p, i) => (
        <Handle
          key={p.id}
          type="source"
          position={Position.Right}
          id={p.id}
          className="!w-2.5 !h-2.5 !border-2 !border-zinc-800"
          style={{
            backgroundColor: p.color,
            top: rowCenter(i),
            transform: 'translateY(-50%)',
          }}
        />
      ))}

      {/* Left column: target label rows */}
      <div className="flex flex-1 flex-col" style={{ paddingTop: PAD, paddingBottom: PAD }}>
        {targets.map((p) => (
          <div
            key={p.id}
            className="flex items-center pl-2.5 leading-none"
            style={{ height: ROW_H }}
          >
            <span className="text-[9px] font-medium" style={{ color: p.color }}>
              {p.label}
            </span>
          </div>
        ))}
      </div>

      {/* Right column: source label rows */}
      <div className="flex flex-1 flex-col items-end" style={{ paddingTop: PAD, paddingBottom: PAD }}>
        {sources.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-end pr-2.5 leading-none"
            style={{ height: ROW_H }}
          >
            <span className="text-[9px] font-medium" style={{ color: p.color }}>
              {p.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ========== Preview Box ========== */
function PreviewBox({
  children,
  className = '',
  placeholder = 'No preview',
}: {
  children?: React.ReactNode;
  className?: string;
  placeholder?: string;
}) {
  const hasContent = children !== undefined;
  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded-md bg-zinc-900 ${hasContent ? '' : 'border border-dashed border-zinc-700'} ${className}`}
    >
      {hasContent ? children : (
        <span className="text-xs text-zinc-500">{placeholder}</span>
      )}
    </div>
  );
}

/* ========== Status Badge ========== */
function StatusBadge({ status }: { status: NodeVisualStatus }) {
  const config: Record<NodeVisualStatus, { label: string; className: string; dotClassName: string }> = {
    idle: { label: 'Idle', className: 'border-zinc-600 bg-zinc-700/50 text-zinc-300', dotClassName: 'bg-zinc-400' },
    processing: { label: 'Processing', className: 'border-yellow-500/40 bg-yellow-500/12 text-yellow-200', dotClassName: 'bg-yellow-300' },
    extracting: { label: 'Extracting', className: 'border-yellow-500/40 bg-yellow-500/12 text-yellow-200', dotClassName: 'bg-yellow-300' },
    done: { label: 'Done', className: 'border-green-500/40 bg-green-500/12 text-green-200', dotClassName: 'bg-green-300' },
    error: { label: 'Error', className: 'border-red-500/40 bg-red-500/12 text-red-200', dotClassName: 'bg-red-300' },
  };
  const c = config[status] || config.idle;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${c.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dotClassName}`} />
      {c.label}
    </span>
  );
}

const STICKY_LS_PREFIX = 'studio-flow-sticky:';

/* ====================================================================
   0. Sticky Note (annotation, no handles)
   ==================================================================== */
export function StickyNoteNode({ id, data }: NodeProps<StickyNoteNodeData>) {
  const { setNodes } = useReactFlow();
  const text = typeof data.text === 'string' ? data.text : '';

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STICKY_LS_PREFIX + id);
      if (stored != null && stored !== '' && text === '') {
        setNodes((nds) =>
          nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, text: stored } } : n))
        );
      }
    } catch {
      /* localStorage unavailable */
    }
  }, [id, text, setNodes]);

  const handleDelete = useCallback(() => {
    try {
      localStorage.removeItem(STICKY_LS_PREFIX + id);
    } catch {
      /* noop */
    }
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setNodes((nds) =>
        nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, text: next } } : n))
      );
      try {
        localStorage.setItem(STICKY_LS_PREFIX + id, next);
      } catch {
        /* noop */
      }
    },
    [id, setNodes]
  );

  return (
    <div className="w-[220px] rounded-lg border border-amber-900/50 bg-amber-950/40 shadow-md">
      <NodeHeader type="stickyNote" onDelete={handleDelete} />
      <div className="p-2">
        <textarea
          value={text}
          onChange={handleChange}
          placeholder="Write a note…"
          className="nodrag nopan min-h-[88px] w-full resize-none rounded-md border border-amber-900/30 bg-amber-100/10 px-2 py-1.5 text-[11px] leading-snug text-amber-50 placeholder:text-amber-200/40 focus:border-amber-600/50 focus:outline-none focus:ring-1 focus:ring-amber-600/30"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

/* ====================================================================
   1. Video Upload Node
   ==================================================================== */
export function VideoUploadNode({ id, data }: NodeProps<VideoUploadNodeData>) {
  const { apiFetch } = useWorkflow();
  const { setNodes, getEdges } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [localCover, setLocalCover] = useState<string | null>(data.coverUrl);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(data.videoUrl);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>(data.uploadStatus || 'idle');
  const [uploadError, setUploadError] = useState<string | null>(data.uploadError);
  const [targetFrameCount, setTargetFrameCount] = useState(data.targetFrameCount ?? 120);

  useEffect(() => {
    if (typeof data.targetFrameCount === 'number' && data.targetFrameCount !== targetFrameCount) {
      setTargetFrameCount(data.targetFrameCount);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.targetFrameCount]);

  // Sync videoUrl from upstream data changes
  useEffect(() => {
    if (data.videoUrl && data.videoUrl !== localVideoUrl) {
      setLocalVideoUrl(data.videoUrl);
    }
    if (data.coverUrl && data.coverUrl !== localCover) {
      setLocalCover(data.coverUrl);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.videoUrl, data.coverUrl]);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  const handleFrameCountInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val >= 1 && val <= 300) {
        setTargetFrameCount(val);
        setNodes((nds) => {
          const withVideo = nds.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, targetFrameCount: val } } : n
          );
          const edges = getEdges();
          const downstreamEdge = edges.find((edge) => edge.source === id);
          if (!downstreamEdge) return withVideo;
          return withVideo.map((n) =>
            n.id === downstreamEdge.target && n.type === 'frameExtraction'
              ? { ...n, data: { ...n.data, targetFrameCount: val } }
              : n
          );
        });
      }
    },
    [id, setNodes, getEdges]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const videoUrl = URL.createObjectURL(file);
      let resolveCoverThumbnail: (value: string | null) => void = () => {};
      const coverThumbnailPromise = new Promise<string | null>((resolve) => {
        resolveCoverThumbnail = resolve;
      });
      let coverSettled = false;
      const settleCoverThumbnail = (value: string | null) => {
        if (coverSettled) return;
        coverSettled = true;
        resolveCoverThumbnail(value);
      };

      // Extract cover image from first frame
      const video = document.createElement('video');
      video.src = videoUrl;
      video.muted = true;
      video.playsInline = true;
      video.addEventListener('error', () => settleCoverThumbnail(null), { once: true });
      video.addEventListener('loadeddata', () => {
        video.currentTime = 0;
      });
      video.addEventListener('seeked', () => {
        const coverCanvas = drawCroppedImageToCanvas(video, video.videoWidth, video.videoHeight, 320, 180);
        const thumbnailCanvas = drawCroppedImageToCanvas(video, video.videoWidth, video.videoHeight, 144, 96);
        if (coverCanvas) {
          const coverUrl = coverCanvas.toDataURL('image/jpeg', 0.8);
          const thumbnailUrl = thumbnailCanvas?.toDataURL('image/jpeg', 0.72) ?? coverUrl;
          setLocalCover(coverUrl);
          settleCoverThumbnail(thumbnailUrl);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, videoUrl, coverUrl, videoName: file.name } }
                : n
            )
          );
        } else {
          settleCoverThumbnail(null);
        }
      }, { once: true });

      // Upload video using chunked upload to bypass CDN body size limit
      setUploadStatus('uploading');
      setUploadError(null);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, videoUrl, videoName: file.name, uploadStatus: 'uploading', uploadError: null } }
            : n
        )
      );

      const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk (well under CDN ~10MB limit)
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      // Step 1: Initialize upload session
      fetch('/api/chunk-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'init',
          fileName: file.name,
          totalChunks,
          contentType: file.type || 'video/mp4',
        }),
      })
        .then((res) => res.json())
        .then(async (initResult) => {
          if (!initResult.success) {
            throw new Error(initResult.error || 'Upload init failed');
          }

          const { sessionId } = initResult;

          // Step 2: Upload chunks sequentially
          for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunkBlob = file.slice(start, end);

            const chunkFormData = new FormData();
            chunkFormData.append('sessionId', sessionId);
            chunkFormData.append('chunkIndex', String(i));
            chunkFormData.append('chunk', chunkBlob);

            const chunkRes = await fetch('/api/chunk-upload', {
              method: 'POST',
              body: chunkFormData,
            });
            const chunkResult = await chunkRes.json();

            if (!chunkResult.success) {
              throw new Error(chunkResult.error || `Chunk ${i + 1}/${totalChunks} upload failed`);
            }
          }

          // Step 3: Complete upload - assemble chunks
          const completeRes = await apiFetch('/api/chunk-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'complete', sessionId }),
          });
          const completeResult = await completeRes.json();

          if (!completeResult.success) {
            throw new Error(completeResult.error || 'Video assembly failed');
          }

          return completeResult;
        })
        .then(async (result) => {
          const { videoServerPath } = result;
          const thumbnailUrl = await Promise.race([
            coverThumbnailPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
          ]);
          setUploadStatus('done');

          // Record uploaded video to asset library
          recordAsset({
            name: data.videoName || 'uploaded-video',
            assetType: 'video',
            fileUrl: videoServerPath,
            fileType: 'mp4',
            thumbnailUrl,
            sourceNode: 'videoUpload',
          });

          // Update this node and push videoServerPath (+ frame count) to downstream FrameExtractionNode
          setNodes((nds) => {
            const updated = nds.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      uploadStatus: 'done',
                      uploadError: null,
                      videoServerPath,
                    },
                  }
                : n
            );

            const videoNode = updated.find((n) => n.id === id);
            const tfcRaw =
              videoNode?.data && typeof videoNode.data === 'object' && 'targetFrameCount' in videoNode.data
                ? (videoNode.data as { targetFrameCount?: number }).targetFrameCount
                : undefined;
            const tfc =
              typeof tfcRaw === 'number' && tfcRaw >= 1 && tfcRaw <= 300 ? tfcRaw : 120;

            const edges = getEdges();
            const downstreamEdge = edges.find((edge) => edge.source === id);
            if (downstreamEdge) {
              const targetId = downstreamEdge.target;
              return updated.map((n) =>
                n.id === targetId
                  ? {
                      ...n,
                      data: {
                        ...n.data,
                        videoServerPath,
                        targetFrameCount: tfc,
                      },
                    }
                  : n
              );
            }
            return updated;
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Network request failed';
          setUploadStatus('error');
          setUploadError(message);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, uploadStatus: 'error', uploadError: message } }
                : n
            )
          );
        });
    },
    [id, data.videoName, setNodes, getEdges, apiFetch]
  );

  const handleClearVideo = useCallback(() => {
    if (uploadStatus === 'uploading') return;
    if (localVideoUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(localVideoUrl);
    }
    setLocalCover(null);
    setLocalVideoUrl(null);
    setUploadStatus('idle');
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                videoUrl: null,
                coverUrl: null,
                videoName: null,
                videoServerPath: null,
                uploadStatus: 'idle' as const,
                uploadError: null,
              },
            }
          : n
      )
    );
  }, [id, localVideoUrl, setNodes, uploadStatus]);

  const hasVideoPreview = !!(localCover || localVideoUrl || data.videoServerPath);

  return (
    <div
      style={getNodeFrameStyle('videoUpload', uploadStatus === 'uploading' ? 'processing' : uploadStatus)}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="videoUpload" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'source', id: 'output', label: 'Video', color: '#4a6a8a' },
      ]}>
        <div className="nodrag nopan flex items-center gap-2">
          <span className="whitespace-nowrap text-[10px] font-medium text-zinc-400">Frame count</span>
          <input
            type="number"
            min={1}
            max={300}
            value={targetFrameCount}
            onChange={handleFrameCountInput}
            className="nodrag nopan h-5 w-14 rounded border border-zinc-600 bg-zinc-950/70 px-1.5 text-center text-[11px] text-zinc-200 outline-none transition-colors focus:border-[#4a6a8a]/70"
          />
        </div>
      </HandleBar>
      <div className="p-3 space-y-2">
        <div
          role="button"
          tabIndex={uploadStatus === 'uploading' ? -1 : 0}
          aria-disabled={uploadStatus === 'uploading'}
          onClick={() => {
            if (uploadStatus !== 'uploading') fileInputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (uploadStatus === 'uploading') return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={`block w-full ${uploadStatus === 'uploading' ? 'cursor-not-allowed' : 'cursor-pointer'}`}
          title="Upload video"
        >
          <PreviewBox className="h-[140px]" placeholder="Click to upload video">
            {localCover ? (
              <DynamicPreviewImage src={localCover} alt="Video cover" className="h-full w-full object-cover" draggable={false} />
            ) : localVideoUrl ? (
              <video src={localVideoUrl} className="h-full w-full object-contain" muted playsInline />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-zinc-600 transition-colors hover:text-zinc-500">
                <Upload size={24} />
              </div>
            )}
            {hasVideoPreview && uploadStatus !== 'uploading' && (
              <PreviewClearIconButton onClick={handleClearVideo} />
            )}
          </PreviewBox>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={handleFileChange}
        />
        {data.videoName && (
          <p className="truncate text-[10px] text-zinc-400">{data.videoName}</p>
        )}
        {uploadStatus === 'uploading' && (
          <div className="flex items-center gap-2 text-xs text-[#7a8a9a]">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#4a5a6a] border-t-[#7a8a9a]" />
            Uploading video to server...
          </div>
        )}
        {uploadStatus === 'done' && data.videoServerPath && (
          <p className="text-[10px] text-[#5a8a6a]">Video uploaded — run workflow or extract frames downstream.</p>
        )}
        {uploadStatus === 'error' && uploadError && (
          <p className="text-[10px] text-[#8a5a5a]">
            Upload failed: {uploadError}
          </p>
        )}
      </div>
    </div>
  );
}

/* ====================================================================
   2. Frame Extraction Node
   ==================================================================== */
export function FrameExtractionNode({ id, data }: NodeProps<FrameExtractionNodeData>) {
  const { setNodes, getEdges, getNodes } = useReactFlow();
  const { workflowRunning, apiFetch } = useWorkflow();
  const [localFrames, setLocalFrames] = useState<string[]>(data.frames || []);
  const [status, setStatus] = useState<'idle' | 'extracting' | 'done' | 'error'>(data.status || 'idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);

  const resolveFrameCount = useCallback((): number => {
    const edges = getEdges();
    const nodes = getNodes();
    const incoming = edges.find((e) => e.target === id && e.targetHandle === 'input');
    if (incoming) {
      const src = nodes.find((n) => n.id === incoming.source);
      if (src?.type === 'videoUpload') {
        const c = (src.data as { targetFrameCount?: unknown }).targetFrameCount;
        if (typeof c === 'number' && c >= 1 && c <= 300) return c;
      }
    }
    if (typeof data.targetFrameCount === 'number' && data.targetFrameCount >= 1 && data.targetFrameCount <= 300) {
      return data.targetFrameCount;
    }
    return 120;
  }, [id, getEdges, getNodes, data.targetFrameCount]);

  // Auto-trigger frame extraction when workflow is running and video is ready
  useEffect(() => {
    if (workflowRunning && data.videoServerPath && status === 'idle') {
      handleExtractFrames();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowRunning, data.videoServerPath]);

  const handleExtractFrames = useCallback(() => {
    if (!data.videoServerPath) return;

    const frameCount = resolveFrameCount();

    setStatus('extracting');
    setErrorMessage(null);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, status: 'extracting', errorMessage: null } }
          : n
      )
    );

    apiFetch('/api/extract-frames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: data.videoServerPath, frameCount }),
    })
      .then((res) => res.json())
      .then((result) => {
        if (!result.success) {
          setStatus('error');
          setErrorMessage(result.error || 'Frame extraction failed');
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, status: 'error', errorMessage: result.error || 'Frame extraction failed' } }
                : n
            )
          );
          return;
        }

        const { frames, outputFolder, frameCount } = result;
        setLocalFrames(frames);
        setStatus('done');
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    frames,
                    outputFolder,
                    frameCount,
                    targetFrameCount: frameCount,
                    status: 'done',
                    errorMessage: null,
                  },
                }
              : n
          )
        );

      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Frame extraction request failed';
        setStatus('error');
        setErrorMessage(message);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, status: 'error', errorMessage: message } }
              : n
          )
        );
      });
  }, [id, data.videoServerPath, resolveFrameCount, setNodes, apiFetch]);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  return (
    <div
      style={getNodeFrameStyle('frameExtraction', status)}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="frameExtraction" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'target', id: 'input', label: 'Video', color: '#4a6a8a' },
        { type: 'source', id: 'output', label: 'Frames', color: '#6b5f7a' },
      ]} />
      <div className="p-3 space-y-2">
        {data.outputFolder && (
          <div className="flex items-center justify-end">
            <span className="flex items-center gap-1 text-[10px] text-zinc-400">
              <FolderOpen size={10} />
              {data.outputFolder}
            </span>
          </div>
        )}
        <PreviewBox className="h-[140px]" placeholder="Frame preview area">
          {localFrames.length > 0 && (
            <div className="grid h-full w-full grid-cols-3 gap-0.5 p-0.5">
              {localFrames.slice(0, 6).map((frame, i) => (
                <DynamicPreviewImage key={i} src={frame} alt={`Frame ${i + 1}`} className="h-full w-full object-cover" />
              ))}
            </div>
          )}
          {status === 'extracting' && (
            <div className="flex items-center gap-2 text-xs text-[#7a8a9a]">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#4a5a6a] border-t-[#7a8a9a]" />
              Extracting {resolveFrameCount()} frames...
            </div>
          )}
        </PreviewBox>
        {/* Extract / Re-extract button */}
        {data.videoServerPath && (
          <button
            onClick={handleExtractFrames}
            disabled={status === 'extracting'}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#6b5f7a]/20 px-3 py-1.5 text-xs text-[#9a8aaa] transition-colors hover:bg-[#6b5f7a]/30 disabled:opacity-50"
          >
            {status === 'done' ? 'Re-extract' : status === 'extracting' ? 'Extracting...' : 'Extract Frames'}
          </button>
        )}
        {!data.videoServerPath && (
          <p className="text-center text-[10px] text-zinc-500">Upload a video first</p>
        )}
        {status === 'error' && errorMessage && (
          <p className="text-[10px] text-[#8a5a5a]">
            Extraction failed: {errorMessage}
          </p>
        )}
        {status === 'done' && data.frameCount > 0 && (
          <p className="text-[10px] text-[#5a8a6a]">
            Extracted {data.frameCount} frames
          </p>
        )}
      </div>
    </div>
  );
}

/* ========== Layer Display Colors (matches pointcloud_segment.py COLOR_PALETTE) ========== */
const LAYER_DISPLAY_COLORS = [
  '#FF0000', '#00FF00', '#0000FF', '#FFFF00',
  '#FF00FF', '#00FFFF', '#FF8000', '#8000FF',
  '#FF0080', '#804000', '#808080', '#0080FF',
  '#00FF80', '#808000', '#800000', '#008080',
];

const GAUSSIAN_PIPELINE_STEPS = [
  { step: 1, label: 'Prepare COLMAP' },
  { step: 2, label: 'Features' },
  { step: 3, label: 'Matching' },
  { step: 4, label: 'Camera Poses' },
  { step: 5, label: 'NS Dataset' },
  { step: 6, label: 'Splatfacto' },
  { step: 7, label: 'Export PLY' },
];

function GaussianPipelineSteps({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex w-full items-start gap-0 px-1">
      {GAUSSIAN_PIPELINE_STEPS.map((s, i) => {
        const isCompleted = currentStep > s.step;
        const isCurrent = currentStep === s.step;
        return (
          <div key={s.step} className="flex min-w-0 flex-1 flex-col items-center">
            <div className="flex w-full items-center">
              {i > 0 && (
                <div
                  className={`h-px flex-1 ${currentStep > GAUSSIAN_PIPELINE_STEPS[i - 1].step ? 'bg-[#7f70c7]' : 'bg-zinc-700'}`}
                />
              )}
              <div
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  isCompleted
                    ? 'border-[#7f70c7] bg-[#7f70c7]'
                    : isCurrent
                      ? 'border-[#b9a7ff] bg-[#6f5aa8]'
                      : 'border-zinc-600 bg-zinc-800'
                }`}
              >
                {isCompleted ? (
                  <Check size={9} className="text-white" />
                ) : (
                  <span className={`text-[8px] ${isCurrent ? 'text-white' : 'text-zinc-500'}`}>{s.step}</span>
                )}
              </div>
              {i < GAUSSIAN_PIPELINE_STEPS.length - 1 && (
                <div className={`h-px flex-1 ${currentStep > s.step ? 'bg-[#7f70c7]' : 'bg-zinc-700'}`} />
              )}
            </div>
            <span
              className={`mt-1 max-w-[42px] text-center text-[7px] leading-tight ${
                isCurrent ? 'text-[#c6b8ff]' : isCompleted ? 'text-[#9d8df0]' : 'text-zinc-600'
              }`}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ====================================================================
   3. Gaussian Splat Generation Node
   ==================================================================== */
export function GaussianSplatNode({ id, data }: NodeProps<GaussianSplatNodeData>) {
  const { setNodes } = useReactFlow();
  const { workflowRunning, apiFetch, ephemeralSessionId } = useWorkflow();
  const plyFileInputRef = useRef<HTMLInputElement>(null);
  const [framePaths, setFramePaths] = useState<string[]>(data.framePaths || []);
  const [sourcePlyUrl, setSourcePlyUrl] = useState<string | null>(data.sourcePlyUrl);
  const [splatUrl, setSplatUrl] = useState<string | null>(data.splatUrl);
  const [gaussianCount, setGaussianCount] = useState<number | null>(data.gaussianCount);
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>(data.status || 'idle');
  const [progressText, setProgressText] = useState<string | null>(data.progressText);
  const [progressStep, setProgressStep] = useState<number | null>(data.progressStep);
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);
  const [trainingIterations, setTrainingIterations] = useState(
    typeof data.trainingIterations === 'number' ? data.trainingIterations : 1000
  );
  const [currentTrainingIteration, setCurrentTrainingIteration] = useState<number | null>(data.currentTrainingIteration ?? null);
  const [maxTrainingIterations, setMaxTrainingIterations] = useState<number | null>(data.maxTrainingIterations ?? null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(data.activeTaskId ?? null);
  const [deviceType, setDeviceType] = useState<GaussianDeviceType | null>(data.deviceType ?? null);
  const [computeBackend, setComputeBackend] = useState<string | null>(data.computeBackend);
  const [trainingMode, setTrainingMode] = useState<GaussianTrainingMode>(normalizeGaussianTrainingMode(data.trainingMode));
  const [targetPlyType, setTargetPlyType] = useState<string | null>(data.targetPlyType ?? null);
  const [trueTrainingAvailable, setTrueTrainingAvailable] = useState<boolean | null>(
    typeof data.trueTrainingAvailable === 'boolean' ? data.trueTrainingAvailable : null
  );
  const [trueTrainingUnavailableReason, setTrueTrainingUnavailableReason] = useState<string | null>(
    data.trueTrainingUnavailableReason ?? null
  );
  const [enableFastSegmentation, setEnableFastSegmentation] = useState(
    typeof data.enableFastSegmentation === 'boolean' ? data.enableFastSegmentation : true
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [plyUploading, setPlyUploading] = useState(false);
  const deviceDetectionStartedRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const previousWorkflowRunningRef = useRef(workflowRunning);
  const activeRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    const incomingFrames = data.framePaths || [];
    const framesChanged =
      incomingFrames.length !== framePaths.length ||
      incomingFrames.some((frame, index) => frame !== framePaths[index]);
    if (framesChanged) setFramePaths(incomingFrames);
    if (data.sourcePlyUrl !== sourcePlyUrl) setSourcePlyUrl(data.sourcePlyUrl);
    if (data.splatUrl !== splatUrl) setSplatUrl(data.splatUrl);
    if (data.gaussianCount !== gaussianCount) setGaussianCount(data.gaussianCount);
    if (data.status !== status) setStatus(data.status || 'idle');
    if (data.progressText !== progressText) setProgressText(data.progressText);
    if (data.progressStep !== progressStep) setProgressStep(data.progressStep);
    if (data.errorMessage !== errorMessage) setErrorMessage(data.errorMessage);
    const incomingTrainingIterations = typeof data.trainingIterations === 'number' ? data.trainingIterations : 1000;
    if (incomingTrainingIterations !== trainingIterations) setTrainingIterations(incomingTrainingIterations);
    if (data.currentTrainingIteration !== currentTrainingIteration) setCurrentTrainingIteration(data.currentTrainingIteration ?? null);
    if (data.maxTrainingIterations !== maxTrainingIterations) setMaxTrainingIterations(data.maxTrainingIterations ?? null);
    if (data.activeTaskId !== activeTaskId) setActiveTaskId(data.activeTaskId ?? null);
    if (data.deviceType !== deviceType) setDeviceType(data.deviceType ?? null);
    if (data.computeBackend !== computeBackend) setComputeBackend(data.computeBackend);
    const incomingTrainingMode = normalizeGaussianTrainingMode(data.trainingMode);
    if (incomingTrainingMode !== trainingMode) setTrainingMode(incomingTrainingMode);
    if (data.targetPlyType !== targetPlyType) setTargetPlyType(data.targetPlyType ?? null);
    const incomingTrueTrainingAvailable =
      typeof data.trueTrainingAvailable === 'boolean' ? data.trueTrainingAvailable : null;
    if (incomingTrueTrainingAvailable !== trueTrainingAvailable) setTrueTrainingAvailable(incomingTrueTrainingAvailable);
    if (data.trueTrainingUnavailableReason !== trueTrainingUnavailableReason) {
      setTrueTrainingUnavailableReason(data.trueTrainingUnavailableReason ?? null);
    }
    const incomingEnableFastSegmentation =
      typeof data.enableFastSegmentation === 'boolean' ? data.enableFastSegmentation : true;
    if (incomingEnableFastSegmentation !== enableFastSegmentation) {
      setEnableFastSegmentation(incomingEnableFastSegmentation);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.framePaths, data.sourcePlyUrl, data.splatUrl, data.gaussianCount, data.status, data.progressText, data.progressStep, data.errorMessage, data.trainingIterations, data.currentTrainingIteration, data.maxTrainingIterations, data.activeTaskId, data.deviceType, data.computeBackend, data.trainingMode, data.targetPlyType, data.trueTrainingAvailable, data.trueTrainingUnavailableReason, data.enableFastSegmentation]);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  const updateTrainingIterations = useCallback((value: number) => {
    setTrainingIterations(value);
    setNodes((nds) =>
      nds.map((n) => n.id === id ? { ...n, data: { ...n.data, trainingIterations: value } } : n)
    );
  }, [id, setNodes]);

  const updateTrainingMode = useCallback((value: GaussianTrainingMode) => {
    if (status === 'processing') return;
    setTrainingMode(value);
    setTargetPlyType(null);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, trainingMode: value, targetPlyType: null } }
          : n
      )
    );
  }, [id, setNodes, status]);

  const updateEnableFastSegmentation = useCallback((value: boolean) => {
    if (status === 'processing') return;
    setEnableFastSegmentation(value);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, enableFastSegmentation: value } }
          : n
      )
    );
  }, [id, setNodes, status]);

  const hasPlyOnlyInput = !!sourcePlyUrl && framePaths.length === 0;
  const effectiveTrainingMode: GaussianTrainingMode = hasPlyOnlyInput ? 'auto' : trainingMode;

  useEffect(() => {
    if (deviceDetectionStartedRef.current) return;
    deviceDetectionStartedRef.current = true;
    let cancelled = false;

    void apiFetch('/api/gaussian-device')
      .then((res) => res.json())
      .then((result) => {
        if (cancelled) return;
        const nextDeviceType = normalizeGaussianDeviceType(result.deviceType);
        if (!nextDeviceType) return;
        const nextTrueTrainingAvailable =
          typeof result.trueTrainingAvailable === 'boolean' ? result.trueTrainingAvailable : nextDeviceType === 'cuda';
        const nextUnavailableReason =
          typeof result.trueTrainingUnavailableReason === 'string' ? result.trueTrainingUnavailableReason : null;
        const nextTrainingMode =
          !nextTrueTrainingAvailable && trainingMode === 'train' ? 'auto' : trainingMode;
        setDeviceType(nextDeviceType);
        setTrueTrainingAvailable(nextTrueTrainingAvailable);
        setTrueTrainingUnavailableReason(nextUnavailableReason);
        if (nextTrainingMode !== trainingMode) {
          setTrainingMode(nextTrainingMode);
          setTargetPlyType(null);
        }
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    deviceType: nextDeviceType,
                    trueTrainingAvailable: nextTrueTrainingAvailable,
                    trueTrainingUnavailableReason: nextUnavailableReason,
                    trainingMode: nextTrainingMode,
                    targetPlyType: nextTrainingMode === trainingMode ? n.data.targetPlyType : null,
                  },
                }
              : n
          )
        );
      })
      .catch(() => {
        deviceDetectionStartedRef.current = false;
      });

    return () => {
      cancelled = true;
      deviceDetectionStartedRef.current = false;
    };
  }, [apiFetch, id, setNodes, trainingMode]);

  useEffect(() => {
    if (trueTrainingAvailable !== false || trainingMode !== 'train') return;
    updateTrainingMode('auto');
  }, [trainingMode, trueTrainingAvailable, updateTrainingMode]);

  useEffect(() => {
    if (!hasPlyOnlyInput || trainingMode !== 'train') return;
    updateTrainingMode('auto');
  }, [hasPlyOnlyInput, trainingMode, updateTrainingMode]);

  useEffect(() => {
    if (status !== 'error' || trueTrainingAvailable !== false || !errorMessage) return;
    const lowerMessage = errorMessage.toLowerCase();
    if (!lowerMessage.includes('gsplat') || !lowerMessage.includes('cuda')) return;

    setStatus('idle');
    setProgressText(null);
    setProgressStep(null);
    setErrorMessage(null);
    setCurrentTrainingIteration(null);
    setMaxTrainingIterations(null);
    setActiveTaskId(null);
    setTrainingMode('auto');
    setTargetPlyType(null);
    cancelRequestedRef.current = false;
    activeRunIdRef.current = null;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                status: 'idle' as const,
                progressText: null,
                progressStep: null,
                errorMessage: null,
                currentTrainingIteration: null,
                maxTrainingIterations: null,
                activeTaskId: null,
                trainingMode: 'auto' as const,
                targetPlyType: null,
              },
            }
          : n
      )
    );
  }, [errorMessage, id, setNodes, status, trueTrainingAvailable]);

  const handlePreviewUploadClick = useCallback(() => {
    if (status === 'processing' || plyUploading) return;
    plyFileInputRef.current?.click();
  }, [plyUploading, status]);

  const handleSourcePlyUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      if (!file.name.toLowerCase().endsWith('.ply')) {
        setStatus('error');
        setErrorMessage('Please upload a .ply file');
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, status: 'error' as const, errorMessage: 'Please upload a .ply file' } }
              : n
          )
        );
        return;
      }

      setPlyUploading(true);
      setErrorMessage(null);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', 'pointcloud/splat-source');

      void apiFetch('/api/upload-model', { method: 'POST', body: formData })
        .then((res) => res.json())
        .then((result) => {
          if (!result.success || !result.url) {
            throw new Error(result.error || 'PLY upload failed');
          }
          const uploadedUrl = result.url as string;
          setFramePaths([]);
          setSourcePlyUrl(uploadedUrl);
          setSplatUrl(null);
          setGaussianCount(null);
          setStatus('idle');
          setProgressText(null);
          setProgressStep(null);
          setErrorMessage(null);
          setCurrentTrainingIteration(null);
          setMaxTrainingIterations(null);
          setActiveTaskId(null);
          setComputeBackend(null);
          setTrainingMode('auto');
          setTargetPlyType(null);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      framePaths: [] as string[],
                      sourcePlyUrl: uploadedUrl,
                      splatUrl: null,
                      gaussianCount: null,
                      status: 'idle' as const,
                      progressText: null,
                      progressStep: null,
                      errorMessage: null,
                      currentTrainingIteration: null,
                      maxTrainingIterations: null,
                      activeTaskId: null,
                      computeBackend: null,
                      trainingMode: 'auto' as const,
                      targetPlyType: null,
                      layerFiles: [] as string[],
                      layerNames: [] as string[],
                    },
                  }
                : n
            )
          );
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'PLY upload failed';
          setStatus('error');
          setErrorMessage(message);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, status: 'error' as const, errorMessage: message } }
                : n
            )
          );
        })
        .finally(() => {
          setPlyUploading(false);
        });
    },
    [apiFetch, id, setNodes]
  );

  const handleClearGaussianSplat = useCallback(() => {
    if (status === 'processing' || plyUploading) return;
    setFramePaths([]);
    setSourcePlyUrl(null);
    setSplatUrl(null);
    setGaussianCount(null);
    setStatus('idle');
    setProgressText(null);
    setProgressStep(null);
    setErrorMessage(null);
    setCurrentTrainingIteration(null);
    setMaxTrainingIterations(null);
    setActiveTaskId(null);
    setComputeBackend(null);
    setTargetPlyType(null);
    cancelRequestedRef.current = false;
    activeRunIdRef.current = null;
    if (plyFileInputRef.current) plyFileInputRef.current.value = '';
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                framePaths: [] as string[],
                sourcePlyUrl: null,
                splatUrl: null,
                gaussianCount: null,
                status: 'idle' as const,
                progressText: null,
                progressStep: null,
                errorMessage: null,
                currentTrainingIteration: null,
                maxTrainingIterations: null,
                activeTaskId: null,
                computeBackend: null,
                targetPlyType: null,
                layerFiles: [] as string[],
                layerNames: [] as string[],
              },
            }
          : n
      )
    );
  }, [id, plyUploading, setNodes, status]);

  const handleGenerateSplat = useCallback(() => {
    const hasFrames = framePaths.length > 0;
    const hasPly = !!sourcePlyUrl;
    if (status === 'processing' || activeRunIdRef.current) return;
    if ((!hasFrames && !hasPly) || !ephemeralSessionId) return;
    const requestTrainingMode: GaussianTrainingMode = hasFrames ? trainingMode : 'auto';
    const requestEnableSegmentation =
      requestTrainingMode === 'auto' &&
      enableFastSegmentation &&
      (hasPly || (hasFrames && deviceType !== 'cuda'));

    setStatus('processing');
    setProgressText(hasFrames ? 'Starting reconstruction for Gaussian splat...' : 'Starting Gaussian splat generation...');
    setProgressStep(0);
    setErrorMessage(null);
    setCurrentTrainingIteration(null);
    setMaxTrainingIterations(trainingIterations);
    setActiveTaskId(null);
    cancelRequestedRef.current = false;
    const runId = crypto.randomUUID();
    activeRunIdRef.current = runId;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                status: 'processing' as const,
                progressText: hasFrames ? 'Starting reconstruction for Gaussian splat...' : 'Starting Gaussian splat generation...',
                progressStep: 0,
                errorMessage: null,
                trainingMode: requestTrainingMode,
                enableFastSegmentation,
                currentTrainingIteration: null,
                maxTrainingIterations: trainingIterations,
                activeTaskId: null,
              },
            }
          : n
      )
    );

    void (async () => {
      try {
        const startRes = await apiFetch('/api/generate-gaussian-splat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            framePaths: hasFrames ? framePaths : undefined,
            plyUrl: hasFrames ? undefined : sourcePlyUrl,
            trainingIterations,
            trainingMode: requestTrainingMode,
            enableSegmentation: requestEnableSegmentation,
            ephemeralSessionId,
          }),
        });
        const started = await startRes.json();
        if (!started.success) {
          throw new Error(started.error || 'Failed to start Gaussian splat generation');
        }
        const startedDeviceType = normalizeGaussianDeviceType(started.deviceType);
        const startedTrainingMode = normalizeGaussianTrainingMode(started.trainingMode);
        const startedTargetPlyType = typeof started.targetPlyType === 'string' ? started.targetPlyType : null;
        const startedTrueTrainingAvailable =
          typeof started.trueTrainingAvailable === 'boolean' ? started.trueTrainingAvailable : undefined;
        const startedTrueTrainingUnavailableReason =
          typeof started.trueTrainingUnavailableReason === 'string' ? started.trueTrainingUnavailableReason : null;
        if (startedDeviceType) setDeviceType(startedDeviceType);
        setTrainingMode(startedTrainingMode);
        setTargetPlyType(startedTargetPlyType);
        if (typeof startedTrueTrainingAvailable === 'boolean') setTrueTrainingAvailable(startedTrueTrainingAvailable);
        setTrueTrainingUnavailableReason(startedTrueTrainingUnavailableReason);
        if (activeRunIdRef.current !== runId) return;
        if (cancelRequestedRef.current) {
          await apiFetch('/api/cancel-gaussian-splat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: started.taskId }),
          }).catch(() => {});
          throw new Error('Gaussian splat generation stopped');
        }
        setActiveTaskId(started.taskId);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    activeTaskId: started.taskId,
                    deviceType: startedDeviceType ?? n.data.deviceType,
                    trainingMode: startedTrainingMode,
                    targetPlyType: startedTargetPlyType,
                    trueTrainingAvailable: startedTrueTrainingAvailable ?? n.data.trueTrainingAvailable,
                    trueTrainingUnavailableReason: startedTrueTrainingUnavailableReason,
                  },
                }
              : n
          )
        );

        const result = await waitForGaussianTask(started.taskId, apiFetch, (task) => {
          if (activeRunIdRef.current !== runId) return;
          const nextProgress = task.progress || 'Generating splats...';
          setProgressText(nextProgress);
          setProgressStep(task.progressStep ?? null);
          if (task.deviceType) setDeviceType(task.deviceType);
          if (task.computeBackend) setComputeBackend(task.computeBackend);
          if (task.trainingMode) setTrainingMode(task.trainingMode);
          if (task.targetPlyType) setTargetPlyType(task.targetPlyType);
          if (typeof task.trueTrainingAvailable === 'boolean') setTrueTrainingAvailable(task.trueTrainingAvailable);
          if (task.trueTrainingUnavailableReason) setTrueTrainingUnavailableReason(task.trueTrainingUnavailableReason);
          if (typeof task.currentTrainingIteration === 'number') {
            setCurrentTrainingIteration(task.currentTrainingIteration);
          }
          if (typeof task.maxTrainingIterations === 'number') {
            setMaxTrainingIterations(task.maxTrainingIterations);
          }
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      progressText: nextProgress,
                      progressStep: task.progressStep ?? null,
                      deviceType: task.deviceType ?? n.data.deviceType,
                      computeBackend: task.computeBackend ?? n.data.computeBackend,
                      trainingMode: task.trainingMode ?? n.data.trainingMode,
                      targetPlyType: task.targetPlyType ?? n.data.targetPlyType,
                      trueTrainingAvailable: task.trueTrainingAvailable ?? n.data.trueTrainingAvailable,
                      trueTrainingUnavailableReason:
                        task.trueTrainingUnavailableReason ?? n.data.trueTrainingUnavailableReason,
                      currentTrainingIteration:
                        typeof task.currentTrainingIteration === 'number'
                          ? task.currentTrainingIteration
                          : n.data.currentTrainingIteration,
                      maxTrainingIterations:
                        typeof task.maxTrainingIterations === 'number'
                          ? task.maxTrainingIterations
                          : n.data.maxTrainingIterations,
                    },
                  }
                : n
            )
          );
        });

        if (activeRunIdRef.current !== runId) return;
        setStatus('done');
        setProgressText(null);
        setProgressStep(null);
        setErrorMessage(null);
        setCurrentTrainingIteration(null);
        setMaxTrainingIterations(null);
        setActiveTaskId(null);
        activeRunIdRef.current = null;
        setSplatUrl(result.splatUrl);
        setSourcePlyUrl(result.sourcePlyUrl);
        setGaussianCount(result.gaussianCount);
        setDeviceType(result.deviceType ?? deviceType);
        setComputeBackend(result.computeBackend || null);
        setTrainingMode(result.trainingMode ?? trainingMode);
        setTargetPlyType(result.targetPlyType ?? targetPlyType);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    sourcePlyUrl: result.sourcePlyUrl,
                    splatUrl: result.splatUrl,
                    gaussianCount: result.gaussianCount,
                    deviceType: result.deviceType ?? n.data.deviceType,
                    computeBackend: result.computeBackend || null,
                    trainingMode: result.trainingMode ?? n.data.trainingMode,
                    targetPlyType: result.targetPlyType ?? n.data.targetPlyType,
                    layerFiles: result.layerFiles || [],
                    layerNames: result.layerNames || [],
                    status: 'done' as const,
                    progressText: null,
                    progressStep: null,
                    currentTrainingIteration: null,
                    maxTrainingIterations: null,
                    activeTaskId: null,
                    errorMessage: null,
                  },
                }
              : n
          )
        );
        void (async () => {
          const thumbnailUrl = await createAssetThumbnail({
            fileUrl: result.splatUrl,
            ephemeralSessionId,
          });
          await recordAsset({
            name: 'Gaussian splat',
            assetType: 'splat',
            fileUrl: result.splatUrl,
            fileType: 'splat-ply',
            thumbnailUrl,
            sourceNode: 'gaussianSplat',
          });
        })();
      } catch (err: unknown) {
        if (activeRunIdRef.current !== runId && !cancelRequestedRef.current) return;
        if (cancelRequestedRef.current) {
          setStatus('idle');
          setProgressText('Stopped');
          setProgressStep(null);
          setErrorMessage(null);
          setCurrentTrainingIteration(null);
          setMaxTrainingIterations(null);
          setActiveTaskId(null);
          activeRunIdRef.current = null;
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      status: 'idle' as const,
                      progressText: 'Stopped',
                      progressStep: null,
                      errorMessage: null,
                      currentTrainingIteration: null,
                      maxTrainingIterations: null,
                      activeTaskId: null,
                    },
                  }
                : n
            )
          );
          return;
        }
        const message = err instanceof Error ? err.message : 'Gaussian splat generation failed';
        setStatus('error');
        setProgressText(null);
        setProgressStep(null);
        setErrorMessage(message);
        setCurrentTrainingIteration(null);
        setMaxTrainingIterations(null);
        setActiveTaskId(null);
        activeRunIdRef.current = null;
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    status: 'error' as const,
                    progressText: null,
                    progressStep: null,
                    errorMessage: message,
                    currentTrainingIteration: null,
                    maxTrainingIterations: null,
                    activeTaskId: null,
                  },
                }
              : n
          )
        );
      }
    })();
  }, [apiFetch, deviceType, enableFastSegmentation, ephemeralSessionId, framePaths, id, setNodes, sourcePlyUrl, status, targetPlyType, trainingIterations, trainingMode]);

  useEffect(() => {
    if (!workflowRunning) return;
    if ((framePaths.length === 0 && !sourcePlyUrl) || splatUrl || status !== 'idle') return;
    handleGenerateSplat();
  }, [workflowRunning, framePaths, sourcePlyUrl, splatUrl, status, handleGenerateSplat]);

  useEffect(() => {
    const justStopped = previousWorkflowRunningRef.current && !workflowRunning;
    previousWorkflowRunningRef.current = workflowRunning;
    if (!justStopped || status !== 'processing') return;

    cancelRequestedRef.current = true;
    activeRunIdRef.current = null;

    if (activeTaskId) {
      void apiFetch('/api/cancel-gaussian-splat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: activeTaskId }),
      }).catch(() => {});
    }

    setStatus('idle');
    setProgressText('Stopped');
    setProgressStep(null);
    setErrorMessage(null);
    setCurrentTrainingIteration(null);
    setMaxTrainingIterations(null);
    setActiveTaskId(null);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                status: 'idle' as const,
                progressText: 'Stopped',
                progressStep: null,
                errorMessage: null,
                currentTrainingIteration: null,
                maxTrainingIterations: null,
                activeTaskId: null,
              },
            }
          : n
      )
    );
  }, [activeTaskId, apiFetch, id, setNodes, status, workflowRunning]);

  const hasTrainingProgress =
    status === 'processing' &&
    typeof currentTrainingIteration === 'number' &&
    typeof maxTrainingIterations === 'number' &&
    maxTrainingIterations > 0;
  const trainingProgressPercent = hasTrainingProgress
    ? Math.min(100, Math.max(0, (currentTrainingIteration / maxTrainingIterations) * 100))
    : 0;
  const hasGaussianPreviewFile = framePaths.length > 0 || !!sourcePlyUrl || !!splatUrl;
  const displayDeviceType = deviceType ? deviceType.toUpperCase() : 'detecting';
  const displayTargetPlyType = targetPlyType || (hasPlyOnlyInput
    ? 'initializer splat PLY from uploaded PLY'
    : getGaussianTargetPlyLabel(deviceType, effectiveTrainingMode));
  const canChooseTrainingMode = deviceType === 'mps' || deviceType === 'cpu';
  const trueTrainingDisabled = status === 'processing' || hasPlyOnlyInput || trueTrainingAvailable !== true;
  const trueTrainingReason = hasPlyOnlyInput
    ? 'True training requires extracted frames and COLMAP camera poses.'
    : trueTrainingUnavailableReason || 'True training requires a CUDA-compatible gsplat runtime.';
  const canToggleFastSegmentation = status !== 'processing';
  const showFastSegmentationControl = effectiveTrainingMode === 'auto' && (deviceType !== 'cuda' || hasPlyOnlyInput);

  return (
    <div
      style={getNodeFrameStyle('gaussianSplat', status)}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="gaussianSplat" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'target', id: 'input', label: 'Frames', color: '#6b5f7a' },
        { type: 'target', id: 'ply-input', label: 'PLY', color: '#4a7a74' },
        { type: 'source', id: 'splat-output', label: 'Splat', color: '#6f5aa8' },
        { type: 'source', id: 'mesh-output', label: 'Mesh PLY', color: '#7a4a55' },
      ]} />
      <div className="space-y-2 p-3">
        <PreviewBox className="h-[140px]" placeholder="Gaussian splat output">
          {plyUploading && (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#514179] border-t-[#b9a7ff]" />
              <span className="text-[11px] text-[#b9a7ff]">Uploading PLY...</span>
            </div>
          )}
          {!plyUploading && status === 'idle' && framePaths.length === 0 && !sourcePlyUrl && (
            <div
              role="button"
              tabIndex={0}
              className="flex h-full w-full cursor-pointer items-center justify-center text-zinc-600 transition-colors hover:text-zinc-500"
              onClick={handlePreviewUploadClick}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handlePreviewUploadClick();
                }
              }}
            >
              <Upload size={24} />
            </div>
          )}
          {!plyUploading && status === 'idle' && (framePaths.length > 0 || sourcePlyUrl) && (
            <div className="flex flex-col items-center gap-2 text-center">
              <Sparkles size={24} className="text-[#b9a7ff]" />
              <span className="text-[11px] text-zinc-400">
                {framePaths.length > 0 ? `${framePaths.length} frames ready` : 'PLY ready'}
              </span>
            </div>
          )}
          {!plyUploading && status === 'processing' && (
            <div className="flex flex-col items-center gap-2 text-center">
              {framePaths.length > 0 && (
                <GaussianPipelineSteps currentStep={progressStep ?? 0} />
              )}
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#514179] border-t-[#b9a7ff]" />
              <span className="px-3 text-[11px] text-[#b9a7ff]">{progressText || 'Generating splats...'}</span>
              {hasTrainingProgress && (
                <div className="w-full max-w-[190px] px-2">
                  <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-[#c6b8ff]">
                    <span>Step</span>
                    <span>
                      {currentTrainingIteration.toLocaleString()}/{maxTrainingIterations.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-700">
                    <div
                      className="h-full rounded-full bg-[#b9a7ff] transition-[width]"
                      style={{ width: `${trainingProgressPercent}%` }}
                    />
                  </div>
                </div>
              )}
              {computeBackend && (
                <span className="text-[10px] text-zinc-500">{computeBackend}</span>
              )}
            </div>
          )}
          {!plyUploading && status === 'done' && splatUrl && (
            <SplatViewer splatUrl={splatUrl} className="h-full w-full" />
          )}
          {!plyUploading && status === 'error' && (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-2">
              <span className="text-xs text-red-400">Splat generation failed</span>
              {errorMessage && (
                <span className="text-center text-[10px] text-zinc-500 line-clamp-3">{errorMessage}</span>
              )}
            </div>
          )}
          {!plyUploading && status === 'done' && splatUrl && (
            <PreviewDownloadIconButton
              onClick={() => {
                const name = buildPreviewDownloadFilename(data.label, id, '.ply');
                void downloadFromUrl(splatUrl, name).catch(() => {
                  /* download may fail on CORS */
                });
              }}
            />
          )}
          {!plyUploading && status !== 'processing' && hasGaussianPreviewFile && (
            <PreviewClearIconButton onClick={handleClearGaussianSplat} />
          )}
        </PreviewBox>
        <input
          ref={plyFileInputRef}
          type="file"
          accept=".ply"
          className="hidden"
          onChange={handleSourcePlyUpload}
        />
        {status === 'done' && splatUrl && (
          <button
            onClick={() => setIsFullscreen(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#6f5aa8]/20 px-3 py-1.5 text-xs text-[#c6b8ff] transition-colors hover:bg-[#6f5aa8]/30"
          >
            <Maximize2 size={12} />
            Fullscreen splat
          </button>
        )}
        {status === 'done' && gaussianCount !== null && gaussianCount > 0 && (
          <p className="text-[10px] text-[#7f70c7]">
            {gaussianCount.toLocaleString()} gaussians
          </p>
        )}
        {status === 'done' && computeBackend && (
          <p className="text-[10px] text-zinc-500">{computeBackend}</p>
        )}
        <div
          className="nodrag nopan space-y-1.5 rounded-md bg-zinc-700/30 px-2.5 py-2"
          onClickCapture={(event) => {
            if (status === 'processing') return;
            const grid = event.currentTarget.querySelector('[data-training-grid]');
            if (!(grid instanceof HTMLElement)) return;
            const rect = grid.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            ) {
              return;
            }
            const segment = Math.min(10, Math.max(1, Math.floor(((event.clientX - rect.left) / rect.width) * 10) + 1));
            const value = segment * 1000;
            updateTrainingIterations(value);
          }}
        >
          <div className="flex items-center justify-between gap-2 rounded border border-zinc-700/70 bg-zinc-900/45 px-2 py-1.5">
            <div className="min-w-0">
              <span className="block text-[9px] uppercase tracking-wide text-zinc-500">Device</span>
              <span className="font-mono text-[10px] text-zinc-200">{displayDeviceType}</span>
            </div>
            <div className="min-w-0 text-right">
              <span className="block text-[9px] uppercase tracking-wide text-zinc-500">PLY target</span>
              <span className="block truncate text-[10px] text-[#c6b8ff]">{displayTargetPlyType}</span>
            </div>
          </div>
          {canChooseTrainingMode && (
            <div className="grid grid-cols-2 overflow-hidden rounded border border-zinc-700 bg-zinc-900/70 text-[10px]">
              <button
                type="button"
                disabled={status === 'processing'}
                onClick={(event) => {
                  event.stopPropagation();
                  updateTrainingMode('auto');
                }}
                className={`nodrag nopan px-2 py-1.5 transition-colors ${
                  effectiveTrainingMode === 'auto'
                    ? 'bg-[#6f5aa8] text-white'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                } ${status === 'processing' ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                Fast initializer
              </button>
              <button
                type="button"
                disabled={trueTrainingDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  if (trueTrainingDisabled) return;
                  updateTrainingMode('train');
                }}
                className={`nodrag nopan border-l border-zinc-700 px-2 py-1.5 transition-colors ${
                  effectiveTrainingMode === 'train'
                    ? 'bg-[#6f5aa8] text-white'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                } ${trueTrainingDisabled ? 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-zinc-400' : ''}`}
              >
                True training
              </button>
            </div>
          )}
          {canChooseTrainingMode && (trueTrainingAvailable === false || hasPlyOnlyInput) && (
            <p className="text-[9px] leading-snug text-zinc-500">
              True training unavailable: {trueTrainingReason}
            </p>
          )}
          {showFastSegmentationControl && (
            <div className="flex items-center justify-between gap-2 rounded border border-zinc-700/70 bg-zinc-900/45 px-2 py-1.5">
              <div className="min-w-0">
                <span className="block text-[10px] text-zinc-300">Auto layers</span>
                <span className="block text-[9px] leading-snug text-zinc-500">
                  Fast initializer point cloud
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enableFastSegmentation}
                disabled={!canToggleFastSegmentation}
                onClick={(event) => {
                  event.stopPropagation();
                  updateEnableFastSegmentation(!enableFastSegmentation);
                }}
                className={`nodrag nopan relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
                  enableFastSegmentation
                    ? 'border-[#6f5aa8] bg-[#6f5aa8]'
                    : 'border-zinc-600 bg-zinc-800'
                } ${canToggleFastSegmentation ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'}`}
              >
                <span
                  className={`absolute left-0.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white transition-transform ${
                    enableFastSegmentation ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-300">Training steps</span>
            <span className="font-mono text-[10px] text-[#c6b8ff]">{trainingIterations.toLocaleString()}</span>
          </div>
          <div data-training-grid className="grid grid-cols-10 overflow-hidden rounded border border-zinc-600 bg-zinc-900">
            {Array.from({ length: 10 }, (_, index) => {
              const value = (index + 1) * 1000;
              const active = value <= trainingIterations;
              return (
                <label
                  key={value}
                  aria-label={`${value} training steps`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  className={`nodrag nopan flex h-6 min-w-0 cursor-pointer items-center justify-center border-r border-zinc-700 last:border-r-0 transition-colors ${
                    status === 'processing'
                      ? 'cursor-not-allowed opacity-60'
                      : active
                        ? 'bg-[#6f5aa8]'
                        : 'bg-zinc-800 hover:bg-zinc-700'
                  }`}
                >
                  <input
                    type="radio"
                    name={`${id}-training-iterations`}
                    value={value}
                    checked={trainingIterations === value}
                    disabled={status === 'processing'}
                    onChange={() => {
                      updateTrainingIterations(value);
                    }}
                    className="sr-only"
                  />
                  <span className="block h-2 w-2 rounded-full bg-white/20" />
                </label>
              );
            })}
          </div>
          <div className="flex justify-between font-mono text-[9px] text-zinc-500">
            <span>1k</span>
            <span>10k</span>
          </div>
        </div>
        {splatUrl && (
          <p className="text-[10px] leading-relaxed text-zinc-500">
            Outputs and previews a 3DGS-compatible PLY.
          </p>
        )}
      </div>
      {isFullscreen && splatUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setIsFullscreen(false)}
        >
          <div
            className="relative h-[85vh] w-[85vw] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
              <span className="text-sm font-medium text-white">Gaussian Splat Preview</span>
              <button
                onClick={() => setIsFullscreen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-700 text-zinc-300 transition-colors hover:bg-zinc-600"
              >
                <X size={14} />
              </button>
            </div>
            <div className="h-[calc(85vh-52px)] w-full">
              <SplatViewer splatUrl={splatUrl} className="h-full w-full" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ====================================================================
   5. Material Generation Node
   ==================================================================== */
export function MaterialNode({ id, data }: NodeProps<MaterialNodeData>) {
  const { setNodes, getEdges } = useReactFlow();
  const { workflowRunning, apiFetch } = useWorkflow();
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>(data.status || 'idle');
  const [textInput, setTextInput] = useState(data.textInput ?? '');
  const [textureUrl, setTextureUrl] = useState<string | null>(data.textureUrl);
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  // Push textureUrl to downstream nodes when texture is ready
  useEffect(() => {
    if (data.textureUrl) {
      const edges = getEdges();
      const downstreamEdges = edges.filter((edge) => edge.source === id);
      if (downstreamEdges.length > 0) {
        setNodes((nds) =>
          nds.map((n) => {
            const edge = downstreamEdges.find((e) => e.target === n.id);
            if (!edge) return n;
            const targetHandle = edge.targetHandle;
            if (targetHandle === 'model-input') {
              return { ...n, data: { ...n.data, modelUrl: data.textureUrl, inputType: 'ply' as const } };
            } else if (targetHandle === 'obj-input') {
              return { ...n, data: { ...n.data, modelUrl: data.textureUrl, inputType: 'obj' as const } };
            }
            // Default: texture handle → textureUrl
            return { ...n, data: { ...n.data, textureUrl: data.textureUrl } };
          })
        );
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.textureUrl]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setTextInput(val);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, textInput: val } }
            : n
        )
      );
    },
    [id, setNodes]
  );

  const handleConfirm = useCallback(() => {
    if (!textInput.trim()) return;
    setStatus('processing');
    setErrorMessage(null);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, status: 'processing', errorMessage: null } }
          : n
      )
    );

    apiFetch('/api/generate-texture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: textInput.trim() }),
    })
      .then((res) => res.json())
      .then((result) => {
        if (!result.success) {
          const errMsg = result.error || 'Material generation failed';
          setStatus('error');
          setErrorMessage(errMsg);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, status: 'error', errorMessage: errMsg } }
                : n
            )
          );
          return;
        }
        setStatus('done');
        setTextureUrl(result.textureUrl);
        setErrorMessage(null);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, status: 'done', textureUrl: result.textureUrl, textureCount: 1, errorMessage: null } }
              : n
          )
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Material generation request failed';
        setStatus('error');
        setErrorMessage(message);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, status: 'error', errorMessage: message } }
              : n
          )
        );
      });
  }, [id, textInput, setNodes, apiFetch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleConfirm();
      }
    },
    [handleConfirm]
  );

  // Auto-trigger material generation when workflow starts running and text input is already ready
  useEffect(() => {
    if (workflowRunning && status === 'idle' && textInput.trim()) {
      handleConfirm();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowRunning, status]);

  return (
    <div
      style={getNodeFrameStyle('material', status)}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="material" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'source', id: 'texture-output', label: 'Material', color: '#aa8a5a' },
      ]} />
      <div className="p-3 space-y-2">
        {/* Text input */}
        <input
          type="text"
          value={textInput}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          placeholder="Enter material description..."
          className="w-full rounded-md border border-zinc-600 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 outline-none transition-colors focus:border-[#8a7e5a]"
        />
        {/* Confirm button */}
        <button
          onClick={handleConfirm}
          disabled={status === 'processing' || !textInput.trim()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--node-accent-soft)] px-3 py-1.5 text-xs text-[var(--node-accent-text)] transition-colors hover:bg-[var(--node-accent-muted)] disabled:opacity-50"
        >
          {status === 'processing' ? (
            <>
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--node-accent-muted)] border-t-[var(--node-accent-text)]" />
              Generating...
            </>
          ) : 'OK'}
        </button>
        {/* Texture preview */}
        <PreviewBox className="h-[80px]" placeholder="Material preview">
          {status === 'processing' ? (
            <div className="flex items-center gap-2 text-xs text-[var(--node-accent-text)]">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--node-accent-muted)] border-t-[var(--node-accent-text)]" />
              Generating...
            </div>
          ) : textureUrl && status === 'done' ? (
            <DynamicPreviewImage
              src={textureUrl}
              alt="Material preview"
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : status === 'error' ? (
            <div className="flex flex-col items-center justify-center gap-1 px-2">
              <span className="text-[10px] text-red-400">Generation failed</span>
              {errorMessage && (
                <span className="text-center text-[9px] text-zinc-500 line-clamp-2">{errorMessage}</span>
              )}
            </div>
          ) : null}
          {textureUrl && status === 'done' && (
            <PreviewDownloadIconButton
              onClick={() => {
                const ext = extFromPathname(textureUrl, '.png');
                const name = buildPreviewDownloadFilename(data.label, id, ext);
                void downloadFromUrl(textureUrl, name).catch(() => {
                  /* download may fail on CORS */
                });
              }}
            />
          )}
        </PreviewBox>
      </div>
    </div>
  );
}

/* ====================================================================
   5. Model Organize Node
   ==================================================================== */
export function ModelOrganizeNode({ id, data }: NodeProps<ModelOrganizeNodeData>) {
  const { setNodes, getEdges } = useReactFlow();
  const { workflowRunning, apiFetch } = useWorkflow();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [modelUrl, setModelUrl] = useState<string | null>(data.modelUrl);
  const [outputUrl, setOutputUrl] = useState<string | null>(data.outputUrl);
  const [outputType, setOutputType] = useState<'glb' | 'fbx' | 'obj' | 'ply' | null>(data.outputType);
  const [isFullscreen, setIsFullscreen] = useState(data.isFullscreen || false);
  const [organizeStatus, setOrganizeStatus] = useState<'idle' | 'organizing' | 'done' | 'error'>(data.organizeStatus || 'idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);
  const [isUploading, setIsUploading] = useState(false);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  const handlePreviewClick = useCallback(() => {
    if (!outputUrl && !modelUrl) {
      fileInputRef.current?.click();
    }
  }, [outputUrl, modelUrl]);

  // Call Blender organize API (per-layer when layerGlbUrls is set, else single)
  const handleOrganize = useCallback(() => {
    const layerGlbIn = (data.layerGlbUrls && data.layerGlbUrls.length > 0) ? data.layerGlbUrls : null;

    if (layerGlbIn) {
      (async () => {
        for (const u of layerGlbIn) {
          if (u.startsWith('blob:')) {
            setErrorMessage('A layer file is still uploading, please wait...');
            return;
          }
        }
        setOrganizeStatus('organizing');
        setErrorMessage(null);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, organizeStatus: 'organizing' as const, errorMessage: null } }
              : n
          )
        );
        try {
          const outGlbs: string[] = [];
          for (const u of layerGlbIn) {
            const res = await apiFetch('/api/blender-organize', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ modelUrl: u }),
            });
            const result = await res.json();
            if (!result.success) {
              throw new Error(result.error || 'Model cleanup failed for a layer');
            }
            const organizedUrl = result.glbUrl || result.modelUrl;
            if (!organizedUrl) {
              throw new Error('No output URL from cleanup');
            }
            outGlbs.push(organizedUrl);
          }
          const names =
            (data.layerNames && data.layerNames.length === outGlbs.length
              ? data.layerNames
              : outGlbs.map((_, i) => `layer_${i}`)) as string[];
          const mergeRes = await apiFetch('/api/merge-glb', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ glbPaths: outGlbs, names }),
          });
          const merged = await mergeRes.json();
          if (!mergeRes.ok || !merged.success) {
            throw new Error(merged.error || 'Failed to merge after cleanup');
          }
          const organizedUrl = merged.mergedGlbUrl as string;
          setOrganizeStatus('done');
          setOutputUrl(organizedUrl);
          setOutputType('glb');
          setErrorMessage(null);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      organizeStatus: 'done' as const,
                      outputUrl: organizedUrl,
                      outputType: 'glb' as const,
                      layerGlbUrls: outGlbs,
                      errorMessage: null,
                    },
                  }
                : n
            )
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Model cleanup failed';
          setOrganizeStatus('error');
          setErrorMessage(message);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, organizeStatus: 'error' as const, errorMessage: message } }
                : n
            )
          );
        }
      })();
      return;
    }

    if (!modelUrl || modelUrl.startsWith('blob:')) {
      setErrorMessage('File is uploading, please wait...');
      return;
    }

    setOrganizeStatus('organizing');
    setErrorMessage(null);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, organizeStatus: 'organizing' as const, errorMessage: null, layerGlbUrls: [] } }
          : n
      )
    );

    apiFetch('/api/blender-organize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelUrl }),
    })
      .then((res) => res.json())
      .then((result) => {
        if (!result.success) {
          setOrganizeStatus('error');
          setErrorMessage(result.error || 'Model cleanup failed');
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, organizeStatus: 'error' as const, errorMessage: result.error || 'Model cleanup failed' } }
                : n
            )
          );
          return;
        }

        const organizedUrl = result.glbUrl || result.modelUrl;
        const organizedType = result.glbUrl ? 'glb' as const : (inferModelType(organizedUrl) || 'obj') as 'glb' | 'fbx' | 'obj' | 'ply';
        setOrganizeStatus('done');
        setOutputUrl(organizedUrl);
        setOutputType(organizedType);
        setErrorMessage(null);

        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    organizeStatus: 'done' as const,
                    outputUrl: organizedUrl,
                    outputType: organizedType,
                    layerGlbUrls: [] as string[],
                    errorMessage: null,
                  },
                }
              : n
          )
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Model cleanup request failed';
        setOrganizeStatus('error');
        setErrorMessage(message);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, organizeStatus: 'error' as const, errorMessage: message } }
              : n
          )
        );
      });
  }, [id, modelUrl, setNodes, data.layerGlbUrls, data.layerNames, apiFetch]);

  // Auto-organize when workflow is running and input is received from upstream (and not yet organized)
  useEffect(() => {
    if (!workflowRunning) return;
    const hasLayerGlbs = (data.layerGlbUrls && data.layerGlbUrls.length > 0) as boolean;
    const hasSingle = modelUrl && !modelUrl.startsWith('blob:');
    if (organizeStatus === 'idle' && (hasLayerGlbs || hasSingle)) {
      handleOrganize();
    }
  }, [workflowRunning, modelUrl, data.layerGlbUrls, organizeStatus, handleOrganize]);

  // Sync data from upstream changes, including global Clear resetting fields to null.
  useEffect(() => {
    if (!data.modelUrl && !data.outputUrl) {
      for (const url of [modelUrl, outputUrl]) {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      }
      setIsUploading(false);
      setIsFullscreen(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
    setModelUrl(data.modelUrl);
    setOutputUrl(data.outputUrl);
    setOutputType(data.outputType);
    setOrganizeStatus(data.organizeStatus || 'idle');
    setErrorMessage(data.errorMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.modelUrl, data.outputUrl, data.outputType, data.organizeStatus, data.errorMessage]);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const mainFile = files[0];
      const ext = mainFile.name.split('.').pop()?.toLowerCase();
      const validExts = ['glb', 'gltf', 'fbx', 'obj', 'ply'];
      if (!ext || !validExts.includes(ext)) {
        setErrorMessage('Unsupported file format');
        return;
      }

      const previewUrl = URL.createObjectURL(mainFile);
      const detectedType = ext === 'gltf' ? 'glb' : (ext as 'glb' | 'fbx' | 'obj' | 'ply');

      setModelUrl(previewUrl);
      setOutputUrl(null);
      setOrganizeStatus('idle');
      setErrorMessage(null);
      setIsUploading(true);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, modelUrl: previewUrl, outputUrl: null, outputType: null, organizeStatus: 'idle' as const, errorMessage: null } }
            : n
        )
      );

      // Upload to server so backend APIs can access the file
      const formData = new FormData();
      formData.append('file', mainFile);
      formData.append('type', 'model');

      for (let i = 1; i < files.length; i++) {
        formData.append('companions', files[i]);
      }

      apiFetch('/api/upload-model', { method: 'POST', body: formData })
        .then((res) => res.json())
        .then((result) => {
          if (!result.success) {
            setErrorMessage('Model upload failed: ' + (result.error || 'Unknown error'));
            setIsUploading(false);
            return;
          }
          const serverUrl = result.url;
          const serverType = inferModelType(serverUrl) || detectedType;
          setModelUrl(serverUrl);
          setIsUploading(false);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, modelUrl: serverUrl, outputType: serverType } }
                : n
            )
          );
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Model upload failed';
          setErrorMessage(message);
          setIsUploading(false);
        });
    },
    [id, setNodes, apiFetch]
  );

  const handleClearModelOrganize = useCallback(() => {
    if (organizeStatus === 'organizing' || isUploading) return;
    for (const url of [modelUrl, outputUrl]) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    setModelUrl(null);
    setOutputUrl(null);
    setOutputType(null);
    setOrganizeStatus('idle');
    setErrorMessage(null);
    setIsFullscreen(false);
    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                modelUrl: null,
                outputUrl: null,
                outputType: null,
                organizeStatus: 'idle' as const,
                errorMessage: null,
                layerFiles: [] as string[],
                layerNames: [] as string[],
                layerGlbUrls: [] as string[],
              },
            }
          : n
      )
    );
  }, [id, isUploading, modelUrl, organizeStatus, outputUrl, setNodes]);

  // Push organized model to downstream when outputUrl changes and organizing is done
  useEffect(() => {
    if (!data.outputUrl || data.organizeStatus !== 'done') return;
    const downstreamOutputUrl = data.outputUrl;
    const edges = getEdges();
    const downstreamEdges = edges.filter((edge) => edge.source === id);
    if (downstreamEdges.length > 0) {
      const actualType = data.outputType || inferModelType(downstreamOutputUrl) || 'obj';
      const currentLayerFiles = data.layerFiles || [];
      const currentLayerNames = data.layerNames || [];
      const currentLayerGlbs = data.layerGlbUrls || [];
      const baseUpdate: Record<string, unknown> = {};
      if (currentLayerFiles.length > 0) baseUpdate.layerFiles = currentLayerFiles;
      if (currentLayerNames.length > 0) baseUpdate.layerNames = currentLayerNames;
      if (currentLayerGlbs.length > 0) baseUpdate.layerGlbUrls = currentLayerGlbs;
      setNodes((nds) =>
        nds.map((n) => {
          const edge = downstreamEdges.find((e) => e.target === n.id);
          if (!edge) return n;
          const targetHandle = edge.targetHandle;
          if (targetHandle === 'model-input') {
            return { ...n, data: { ...n.data, modelUrl: downstreamOutputUrl, inputType: actualType as 'glb' | 'obj' | 'ply', ...baseUpdate } };
          }
          return { ...n, data: { ...n.data, modelUrl: downstreamOutputUrl, ...baseUpdate } };
        })
      );
    }
  }, [data.outputUrl, data.organizeStatus, data.outputType, id, getEdges, setNodes, data.layerGlbUrls, data.layerNames, data.layerFiles]);

  // Preview: show outputUrl if organized, otherwise show input modelUrl
  const previewUrl = outputUrl || modelUrl;
  const previewType = outputType || (modelUrl ? inferModelType(modelUrl) : null);

  return (
    <div
      style={getNodeFrameStyle('modelOrganize', organizeStatus === 'organizing' ? 'processing' : organizeStatus)}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="modelOrganize" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'target', id: 'obj-input', label: 'Model', color: '#7a4a55' },
        { type: 'source', id: 'obj-output', label: 'Model', color: '#7a4a55' },
      ]} />
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-400">
            {isUploading ? 'Uploading...' : organizeStatus === 'organizing' ? 'Cleaning up...' : previewUrl ? ((previewType?.toUpperCase() || '') + ' Model') : 'Model Cleanup Preview'}
          </span>
          <div className="flex items-center gap-1">
            {organizeStatus === 'organizing' && <StatusBadge status="processing" />}
            {organizeStatus === 'error' && <StatusBadge status="error" />}
            {previewUrl && (
              <button
                onClick={() => setIsFullscreen(true)}
                className="flex h-6 w-6 items-center justify-center rounded bg-zinc-700 text-zinc-300 transition-colors hover:bg-zinc-600"
                title="Fullscreen"
              >
                <Maximize2 size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Preview area */}
        <div
          className="relative h-[140px] cursor-pointer overflow-hidden rounded-md border border-dashed border-zinc-600 bg-zinc-900 transition-colors hover:border-[#5a6878]/50 nodrag nopan"
          onClick={handlePreviewClick}
        >
          {!previewUrl ? (
            <div className="flex h-full items-center justify-center text-zinc-600">
              <Upload size={24} />
            </div>
          ) : (
            <ModelViewer
              modelUrl={previewUrl}
              modelType={previewType}
              className="h-full w-full"
            />
          )}
          {organizeStatus === 'organizing' && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/70 z-10">
              <div className="flex items-center gap-2 text-xs text-[#5a8a7a]">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#3a6a5a] border-t-[#5a8a7a]" />
                Blender cleaning up...
              </div>
            </div>
          )}
          {previewUrl && organizeStatus !== 'organizing' && !isUploading && (
            <PreviewDownloadIconButton
              onClick={() => {
                const ext =
                  previewType != null ? `.${previewType}` : extFromPathname(previewUrl, '.glb');
                const name = buildPreviewDownloadFilename(data.label, id, ext);
                void downloadFromUrl(previewUrl, name).catch(() => {
                  /* download may fail on CORS */
                });
              }}
            />
          )}
          {previewUrl && organizeStatus !== 'organizing' && !isUploading && (
            <PreviewClearIconButton onClick={handleClearModelOrganize} />
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".glb,.gltf,.fbx,.obj,.ply,.mtl,.png,.jpg,.jpeg"
          multiple
          className="hidden"
          onChange={handleFileUpload}
        />

        {/* Re-organize button when done */}
        {organizeStatus === 'done' && (
          <button
            onClick={() => {
              setOrganizeStatus('idle');
              handleOrganize();
            }}
            disabled={false}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#5a6878]/20 px-3 py-1.5 text-xs text-[#7a8898] transition-colors hover:bg-[#5a6878]/30"
          >
            <Box size={12} />
            Re-clean
          </button>
        )}

        {modelUrl && (
          <p className="truncate text-[10px] text-zinc-400">
            Input: Model file
          </p>
        )}
        {organizeStatus === 'done' && (
          <p className="text-[10px] text-[#5a8a6a]">
            Model cleanup complete
          </p>
        )}
        {errorMessage && (
          <p className="text-[10px] text-[#8a5a5a]">
            {errorMessage}
          </p>
        )}
      </div>

      {/* Fullscreen overlay */}
      {isFullscreen && previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setIsFullscreen(false)}
        >
          <div
            className="relative h-[80vh] w-[80vw] rounded-lg border border-zinc-700 bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setIsFullscreen(false)}
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-700 text-white transition-colors hover:bg-zinc-600"
            >
              <X size={16} />
            </button>
            <ModelViewer
              modelUrl={previewUrl}
              modelType={previewType}
              className="h-full w-full"
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ====================================================================
   6. Video Preview Node
   ==================================================================== */
export function VideoPreviewNode({ id, data }: NodeProps<VideoPreviewNodeData>) {
  const { setNodes } = useReactFlow();
  const { workflowRunning, apiFetch } = useWorkflow();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(data.videoUrl);
  const [videoName, setVideoName] = useState<string | null>(data.videoName);
  const [modelUrl, setModelUrl] = useState<string | null>(data.modelUrl);
  const [videoGenerating, setVideoGenerating] = useState(data.videoGenerating || false);
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lightParams, setLightParams] = useState<LightParams | null>(data.lightParams || null);

  // Sync upstream data changes to local state
  useEffect(() => { setVideoUrl(data.videoUrl); }, [data.videoUrl]);
  useEffect(() => { setVideoName(data.videoName); }, [data.videoName]);
  useEffect(() => { setModelUrl(data.modelUrl); }, [data.modelUrl]);
  useEffect(() => { if (data.lightParams) setLightParams(data.lightParams); }, [data.lightParams]);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  // Helper: check if a URL is a browser blob URL (not yet uploaded to server)
  const isBlobUrl = (url: string | null): boolean => !!url && url.startsWith('blob:');

  // Generate 360° rotation video from OBJ model
  const handleGenerateVideo = useCallback(() => {
    const inputModelUrl = modelUrl;
    if (!inputModelUrl || isBlobUrl(inputModelUrl)) {
      setErrorMessage('Model file unavailable, please wait for upload');
      return;
    }

    setVideoGenerating(true);
    setErrorMessage(null);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, videoGenerating: true, errorMessage: null } }
          : n
      )
    );

    apiFetch('/api/generate-rotation-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelUrl: inputModelUrl, lightParams }),
    })
      .then((res) => res.json())
      .then((result) => {
        if (!result.success) {
          setVideoGenerating(false);
          setErrorMessage(result.error || 'Video generation failed');
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, videoGenerating: false, errorMessage: result.error } }
                : n
            )
          );
          return;
        }

        setVideoGenerating(false);
        setVideoUrl(result.videoUrl);
        setVideoName('Rotation Preview');
        setErrorMessage(null);

        // Record rendered video to asset library
        recordAsset({
          name: 'Rotation preview video',
          assetType: 'render-video',
          fileUrl: result.videoUrl,
          fileType: 'mp4',
          sourceNode: 'videoPreview',
        });
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    videoGenerating: false,
                    videoUrl: result.videoUrl,
                    videoName: 'Rotation Preview',
                    errorMessage: null,
                  },
                }
              : n
          )
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Video generation request failed';
        setVideoGenerating(false);
        setErrorMessage(message);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, videoGenerating: false, errorMessage: message } }
              : n
          )
        );
      });
  }, [id, modelUrl, setNodes, lightParams, apiFetch]);

  // Auto-generate video when workflow is running and modelUrl is ready
  useEffect(() => {
    if (!workflowRunning) return;
    if (modelUrl && !isBlobUrl(modelUrl) && !videoUrl && !videoGenerating) {
      handleGenerateVideo();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowRunning, modelUrl]);

  const handleFullscreenDialogClick = useCallback(() => {
    setIsFullscreen(true);
  }, []);

  return (
    <div
      style={getNodeFrameStyle(
        'videoPreview',
        videoGenerating ? 'processing' : errorMessage ? 'error' : videoUrl ? 'done' : 'idle',
        VIDEO_PREVIEW_NODE_WIDTH
      )}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="videoPreview" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'target', id: 'obj-input', label: 'Model', color: '#7a4a55' },
        { type: 'source', id: 'output', label: 'Video', color: '#4a6a8a' },
      ]} />
      <div className="p-3 space-y-2">
        {/* Preview area — full inner width, 1:1 aspect */}
        <div className="group relative aspect-square w-full overflow-hidden rounded-md bg-zinc-900">
          {videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="h-full w-full object-contain"
                style={{ backgroundColor: '#09090b' }}
              />
              <div className="pointer-events-none absolute right-1.5 bottom-1.5 z-20 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 [div:hover>&]:opacity-100">
                <button
                  type="button"
                  title="Download"
                  onClick={(e) => {
                    e.stopPropagation();
                    const ext = extFromPathname(videoUrl, '.mp4');
                    const name = buildPreviewDownloadFilename(data.label, id, ext);
                    void downloadFromUrl(videoUrl, name).catch(() => {
                      /* download may fail on CORS */
                    });
                  }}
                  className="nodrag nopan pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-zinc-200 transition-colors hover:bg-black/80"
                >
                  <Download size={14} />
                </button>
                <button
                  type="button"
                  onClick={handleFullscreenDialogClick}
                  className="nodrag nopan pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-zinc-200 transition-colors hover:bg-black/80"
                  title="Fullscreen"
                >
                  <Maximize2 size={12} />
                </button>
              </div>
            </>
          ) : modelUrl ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <Box size={24} className="text-zinc-500" />
              <span className="text-xs text-zinc-500">
                {videoGenerating ? 'Generating rotation video...' : 'Model ready'}
              </span>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <MonitorPlay size={24} className="text-zinc-500" />
              <span className="text-xs text-zinc-500">Waiting for model input</span>
            </div>
          )}
          {videoGenerating && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/70 z-10">
              <div className="flex items-center gap-2 text-xs text-[#5a8a7a]">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#3a6a5a] border-t-[#5a8a7a]" />
                Generate rotation video...
              </div>
            </div>
          )}
        </div>

        {/* Generate / Re-generate rotation video button */}
        {modelUrl && !isBlobUrl(modelUrl) && (
          <button
            onClick={(e) => { e.stopPropagation(); handleGenerateVideo(); }}
            disabled={videoGenerating}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#5a6878]/30 px-3 py-1.5 text-[10px] font-medium text-[#8a9aaa] transition-colors hover:bg-[#5a6878]/50 disabled:opacity-50 disabled:cursor-not-allowed nodrag"
          >
            {videoGenerating ? (
              <>
                <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-[#7a8a9a] border-t-[#5a6878]" />
                Generating rotation video...
              </>
            ) : (
              <>
                <Video size={10} />
                {videoUrl ? 'Regenerate 360° rotation video' : 'Generate 360° rotation video'}
              </>
            )}
          </button>
        )}

        {videoName && videoUrl && (
          <p className="truncate text-[10px] text-zinc-400">{videoName}</p>
        )}
        {videoUrl && (
          <p className="text-[10px] text-[#5a7a8a]">Rotation video generated</p>
        )}
        {errorMessage && (
          <p className="text-[10px] text-[#8a5a5a]">{errorMessage}</p>
        )}
      </div>

      {/* Fullscreen Dialog */}
      {isFullscreen && videoUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={() => setIsFullscreen(false)}
        >
          <div
            className="relative h-[85vh] w-[85vw] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
              <span className="text-sm font-medium text-white">
                Video Preview - {videoName}
              </span>
              <button
                onClick={() => setIsFullscreen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-700 text-zinc-300 transition-colors hover:bg-zinc-600"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex h-[calc(85vh-52px)] items-center justify-center">
              <video
                src={videoUrl}
                controls
                autoPlay
                className="max-h-full max-w-full object-contain"
                style={{ backgroundColor: '#09090b' }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ====================================================================
   7. Model Surface Processing Node
   ==================================================================== */
export function ModelSurfaceNode({ id, data }: NodeProps<ModelSurfaceNodeData>) {
  const { setNodes, getEdges } = useReactFlow();
  const { apiFetch } = useWorkflow();
  const objFileInputRef = useRef<HTMLInputElement>(null);
  const textureInputRef = useRef<HTMLInputElement>(null);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(data.selectedLayer);
  const [blenderProcessing, setBlenderProcessing] = useState(data.blenderProcessing || false);
  const [blenderError, setBlenderError] = useState<string | null>(data.blenderError);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [objFileName, setObjFileName] = useState<string | null>(null);
  const [textureFileName, setTextureFileName] = useState<string | null>(data.materialFileName);
  const [isUploading, setIsUploading] = useState(false);
  const [detectedLayers, setDetectedLayers] = useState<string[]>([]);

  // Helper: check if a URL is a browser blob URL (not yet uploaded to server)
  const isBlobUrl = (url: string | null): boolean => !!url && url.startsWith('blob:');

  // Per-layer material params — current working copy for the selected layer
  const [layerParams, setLayerParams] = useState<Record<string, MaterialParams>>(
    data.layerParams || {}
  );
  const currentParams = selectedLayer
    ? layerParams[selectedLayer] || { ...DEFAULT_MATERIAL_PARAMS }
    : { ...DEFAULT_MATERIAL_PARAMS };

  // Light params — stored on node data, persisted to downstream
  const [lightParams, setLightParams] = useState<LightParams>(
    data.lightParams || { ...DEFAULT_LIGHT_PARAMS }
  );

  const layerFiles = data.layerFiles || [];
  const layerNames = useMemo(() => data.layerNames || [], [data.layerNames]);
  const hasPerLayerGlbs = (data.layerGlbUrls?.length ?? 0) > 0;
  const layerUrlBForPreview = (data.layerUrlB || {}) as Record<string, string>;
  const hasLayerPreviewOverrides = Object.values(layerUrlBForPreview).some(Boolean);
  const shouldUseLayerMergedPreview = hasPerLayerGlbs && (!!selectedLayer || hasLayerPreviewOverrides);

  /** Browser-only merged GLB preview for per-layer GLB workflow */
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const previewBlobUrlRef = useRef<string | null>(null);
  previewBlobUrlRef.current = previewBlobUrl;
  /** Old preview blob URLs; revoked after viewer confirms the current `previewBlobUrl` loaded (see handlePreviewGlbLoadSuccess). */
  const previewBlobRevokeQueueRef = useRef<string[]>([]);
  const [previewMergeBusy, setPreviewMergeBusy] = useState(false);
  const mergeCacheRef = useRef<{ fp: string; entries: Map<string, string> }>({ fp: '', entries: new Map() });
  const blobRevokeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const scheduleRevokeBlobUrl = useCallback((url: string | null | undefined) => {
    if (typeof url !== 'string' || !url.startsWith('blob:')) return;
    const target = url;
    const tid = setTimeout(() => {
      try {
        URL.revokeObjectURL(target);
      } catch {
        /* noop */
      }
      blobRevokeTimersRef.current = blobRevokeTimersRef.current.filter((x) => x !== tid);
    }, PREVIEW_BLOB_REVOKE_DELAY_MS);
    blobRevokeTimersRef.current.push(tid);
  }, []);

  const handlePreviewGlbLoadSuccess = useCallback((loadedUrl: string) => {
    const current = previewBlobUrlRef.current;
    const q = previewBlobRevokeQueueRef.current;
    if (loadedUrl === current) {
      for (const u of q) {
        if (typeof u === 'string' && u.startsWith('blob:') && u !== current) {
          try {
            URL.revokeObjectURL(u);
          } catch {
            /* noop */
          }
        }
      }
      q.length = 0;
    } else if (typeof loadedUrl === 'string' && loadedUrl.startsWith('blob:') && loadedUrl !== current) {
      try {
        URL.revokeObjectURL(loadedUrl);
      } catch {
        /* noop */
      }
      const idx = q.indexOf(loadedUrl);
      if (idx >= 0) q.splice(idx, 1);
    }
  }, []);

  const prevUpstreamGlbKeyRef = useRef<string>('');
  const layerParamsRef = useRef(layerParams);
  layerParamsRef.current = layerParams;
  const selectedLayerRef = useRef(selectedLayer);
  selectedLayerRef.current = selectedLayer;
  const lightParamsRef = useRef(lightParams);
  lightParamsRef.current = lightParams;
  const surfaceApiRef = useRef({
    materialPreviewUrl: null as string | null,
    layerUrlA: {} as Record<string, string>,
    dataLightParams: null as LightParams | null,
  });
  surfaceApiRef.current = {
    materialPreviewUrl: data.materialPreviewUrl,
    layerUrlA: (data.layerUrlA || {}) as Record<string, string>,
    dataLightParams: data.lightParams || null,
  };
  /** Skip one auto-Blender debounce after layer selection (only fire on material edits). */
  const skipAutoBlenderOnceRef = useRef(false);
  const autoBlenderAbortRef = useRef<AbortController | null>(null);

  // Determine what to show in the preview
  const previewModelUrl = shouldUseLayerMergedPreview
    ? (previewBlobUrl || data.modelUrl)
    : (data.outputModelUrl || data.modelUrl);
  const previewModelType: 'glb' | 'fbx' | 'obj' | 'ply' | null = shouldUseLayerMergedPreview
    ? previewBlobUrl
      ? 'glb'
      : ((inferModelType(data.modelUrl || '') || 'glb') as 'glb' | 'fbx' | 'obj' | 'ply')
    : (data.outputModelType || (data.modelUrl ? (inferModelType(data.modelUrl) || 'obj') as 'glb' | 'fbx' | 'obj' | 'ply' : null));

  // Sync upstream per-layer GLBs → url_a (reset url_b / url_c when upstream changes)
  useEffect(() => {
    const glbs = data.layerGlbUrls || [];
    const names = data.layerNames || [];
    const key = JSON.stringify({ glbs, names });
    if (glbs.length === 0) {
      if (prevUpstreamGlbKeyRef.current !== '') {
        prevUpstreamGlbKeyRef.current = '';
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    layerUrlA: {} as Record<string, string>,
                    layerUrlB: {} as Record<string, string>,
                    layerUrlC: {} as Record<string, string>,
                  },
                }
              : n
          )
        );
      }
      return;
    }
    if (key === prevUpstreamGlbKeyRef.current) return;
    prevUpstreamGlbKeyRef.current = key;

    const nextA = buildLayerUrlMap(glbs, names);
    const layerCBlobsToRevoke: string[] = [];
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== id) return n;
        const oldC = ((n.data as { layerUrlC?: Record<string, string> }).layerUrlC) || {};
        for (const u of Object.values(oldC)) {
          if (typeof u === 'string' && u.startsWith('blob:')) layerCBlobsToRevoke.push(u);
        }
        return {
          ...n,
          data: {
            ...n.data,
            layerUrlA: nextA,
            layerUrlB: {} as Record<string, string>,
            layerUrlC: {} as Record<string, string>,
          },
        };
      })
    );
    for (const u of layerCBlobsToRevoke) scheduleRevokeBlobUrl(u);
  }, [data.layerGlbUrls, data.layerNames, id, setNodes, scheduleRevokeBlobUrl]);

  // Browser-merge preview (highlight selected layer; cache by selection + per-layer url fingerprint)
  useEffect(() => {
    if (!shouldUseLayerMergedPreview) {
      for (const u of previewBlobRevokeQueueRef.current) {
        if (typeof u === 'string' && u.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(u);
          } catch {
            /* noop */
          }
        }
      }
      previewBlobRevokeQueueRef.current = [];
      for (const url of mergeCacheRef.current.entries.values()) {
        if (url.startsWith('blob:')) scheduleRevokeBlobUrl(url);
      }
      setPreviewBlobUrl((prev) => {
        if (prev?.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(prev);
          } catch {
            /* noop */
          }
        }
        return null;
      });
      mergeCacheRef.current = { fp: '', entries: new Map() };
      return;
    }

    const layerUrlA = (data.layerUrlA || {}) as Record<string, string>;
    const layerUrlB = (data.layerUrlB || {}) as Record<string, string>;
    const entries = orderedLayerPreviewGlbEntries(
      data.layerGlbUrls || [],
      layerNames,
      layerUrlA,
      layerUrlB,
    ).filter((e) => isGltfLikeUrl(e.url));
    if (entries.length === 0) {
      if ((data.layerGlbUrls?.length ?? 0) > 0) {
        setBlenderError(
          'Per-layer preview merge needs .glb/.gltf URLs. OBJ/other formats cannot be merged in the browser.',
        );
      }
      return;
    }

    const fp = entries.map((e) => `${e.layerName}\0${e.url}`).join('\n');
    const cacheKey = `${selectedLayer ?? '__all__'}|${fp}`;

    if (mergeCacheRef.current.fp !== fp) {
      for (const url of mergeCacheRef.current.entries.values()) {
        if (url.startsWith('blob:')) scheduleRevokeBlobUrl(url);
      }
      mergeCacheRef.current = { fp, entries: new Map() };
    }

    const cached = mergeCacheRef.current.entries.get(cacheKey);
    if (cached) {
      setPreviewBlobUrl((prev) => {
        if (prev && prev !== cached && prev.startsWith('blob:')) previewBlobRevokeQueueRef.current.push(prev);
        return cached;
      });
      return;
    }

    let cancelled = false;
    setPreviewMergeBusy(true);
    mergeLayerGlbsInBrowser(entries, selectedLayer)
      .then((buf) => {
        if (cancelled) return;
        setBlenderError(null);
        const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
        mergeCacheRef.current.entries.set(cacheKey, blobUrl);
        setPreviewBlobUrl((prev) => {
          if (prev && prev !== blobUrl && prev.startsWith('blob:')) previewBlobRevokeQueueRef.current.push(prev);
          return blobUrl;
        });
      })
      .catch((err: unknown) => {
        console.error('[surface preview merge]', err);
        const msg = err instanceof Error ? err.message : 'Preview merge failed (browser)';
        setBlenderError(msg);
      })
      .finally(() => {
        if (!cancelled) setPreviewMergeBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    shouldUseLayerMergedPreview,
    data.layerGlbUrls,
    data.layerNames,
    data.layerUrlA,
    data.layerUrlB,
    selectedLayer,
    id,
    layerNames,
    scheduleRevokeBlobUrl,
  ]);

  // Debounced auto Blender for selected layer (url_a only), writes url_b — 0.5s after material change
  const selectedParamsKey =
    selectedLayer && layerParams[selectedLayer]
      ? JSON.stringify(layerParams[selectedLayer])
      : '';

  useEffect(() => {
    if (!hasPerLayerGlbs || !selectedLayer) return;
    if (skipAutoBlenderOnceRef.current) {
      skipAutoBlenderOnceRef.current = false;
      return;
    }
    const layerUrlA = (data.layerUrlA || {}) as Record<string, string>;
    const urlA = layerUrlA[selectedLayer];
    if (!urlA || isBlobUrl(urlA)) return;

    const t = setTimeout(() => {
      const layer = selectedLayerRef.current;
      const a = surfaceApiRef.current.layerUrlA[layer!];
      if (!layer || !a || isBlobUrl(a)) return;
      const p = { ...DEFAULT_MATERIAL_PARAMS, ...layerParamsRef.current[layer] };
      const lp = surfaceApiRef.current.dataLightParams || lightParamsRef.current;

      autoBlenderAbortRef.current?.abort();
      const ac = new AbortController();
      autoBlenderAbortRef.current = ac;

      setBlenderProcessing(true);
      setBlenderError(null);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, blenderProcessing: true, blenderError: null } } : n
        )
      );

      apiFetch('/api/blender-material', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          action: 'apply',
          modelUrl: a,
          textureUrl: surfaceApiRef.current.materialPreviewUrl || undefined,
          group: 'all',
          materialParams: p,
          baseColorModified: !!p.base_color_modified,
          lightParams: lp,
          render: false,
        }),
      })
        .then(async (res) => {
          const text = await res.text();
          let result: {
            success?: boolean;
            error?: string;
            glbUrl?: string;
            modelUrl?: string;
            glbError?: string;
          };
          try {
            result = JSON.parse(text) as typeof result;
          } catch {
            const head = text.trim().slice(0, 160).replace(/\s+/g, ' ');
            throw new Error(
              `blender-material returned non-JSON (HTTP ${res.status}). ${head || '(empty body)'}`,
            );
          }
          if (!res.ok) {
            throw new Error((result.error as string) || `HTTP ${res.status}`);
          }
          if (!result.success) {
            throw new Error((result.error as string) || 'Blender failed');
          }
          if (!result.glbUrl) {
            const detail =
              typeof result.glbError === 'string' && result.glbError.trim()
                ? ` (${result.glbError.trim().slice(0, 240)})`
                : '';
            const hint =
              result.modelUrl != null
                ? `Blender did not return a GLB for this layer (OBJ exported, GLB step failed${detail}). Per-layer preview needs .glb — url_b was not updated.`
                : `Blender returned no glbUrl${detail}; url_b was not updated.`;
            setBlenderError(hint);
            setNodes((nds) =>
              nds.map((n) =>
                n.id === id
                  ? { ...n, data: { ...n.data, blenderProcessing: false, blenderError: hint } }
                  : n
              )
            );
            return;
          }
          const glb = result.glbUrl as string;
          setNodes((nds) =>
            nds.map((n) => {
              if (n.id !== id) return n;
              const prevB = { ...((n.data as { layerUrlB?: Record<string, string> }).layerUrlB || {}) };
              prevB[layer] = glb;
              return {
                ...n,
                data: {
                  ...n.data,
                  blenderProcessing: false,
                  blenderError: null,
                  layerUrlB: prevB,
                  layerParams: layerParamsRef.current,
                },
              };
            })
          );
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') {
            setNodes((nds) =>
              nds.map((n) =>
                n.id === id ? { ...n, data: { ...n.data, blenderProcessing: false } } : n
              )
            );
            return;
          }
          const message = err instanceof Error ? err.message : 'Blender request failed';
          setBlenderError(message);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, blenderProcessing: false, blenderError: message } }
                : n
            )
          );
        })
        .finally(() => {
          setBlenderProcessing(false);
        });
    }, LAYER_BLENDER_DEBOUNCE_MS);

    return () => {
      clearTimeout(t);
      autoBlenderAbortRef.current?.abort();
    };
  }, [
    hasPerLayerGlbs,
    selectedLayer,
    selectedParamsKey,
    data.layerUrlA,
    data.materialPreviewUrl,
    id,
    setNodes,
    apiFetch,
  ]);

  /** Keep local spinner in sync if node data is cleared elsewhere */
  useEffect(() => {
    if (data.blenderProcessing === false && blenderProcessing) {
      setBlenderProcessing(false);
    }
  }, [data.blenderProcessing, blenderProcessing]);

  /** Keep local preview state in sync when the top bar Clear action resets node data. */
  useEffect(() => {
    const cleared =
      !data.modelUrl &&
      !data.outputModelUrl &&
      !data.materialPreviewUrl &&
      (data.layerGlbUrls?.length ?? 0) === 0 &&
      (data.layerFiles?.length ?? 0) === 0;
    if (!cleared) return;

    autoBlenderAbortRef.current?.abort();
    for (const u of previewBlobRevokeQueueRef.current) {
      if (typeof u === 'string' && u.startsWith('blob:')) scheduleRevokeBlobUrl(u);
    }
    previewBlobRevokeQueueRef.current = [];
    for (const url of mergeCacheRef.current.entries.values()) {
      if (url.startsWith('blob:')) scheduleRevokeBlobUrl(url);
    }
    mergeCacheRef.current = { fp: '', entries: new Map() };
    if (previewBlobUrl?.startsWith('blob:')) scheduleRevokeBlobUrl(previewBlobUrl);
    setPreviewBlobUrl(null);
    setPreviewMergeBusy(false);
    setSelectedLayer(null);
    setDetectedLayers([]);
    setLayerParams({});
    setBlenderProcessing(false);
    setBlenderError(null);
    setObjFileName(null);
    setTextureFileName(null);
    setIsUploading(false);
    setIsFullscreen(false);
    prevUpstreamGlbKeyRef.current = '';
    if (objFileInputRef.current) objFileInputRef.current.value = '';
    if (textureInputRef.current) textureInputRef.current.value = '';
  }, [
    data.modelUrl,
    data.outputModelUrl,
    data.materialPreviewUrl,
    data.layerGlbUrls,
    data.layerFiles,
    previewBlobUrl,
    scheduleRevokeBlobUrl,
  ]);

  useEffect(
    () => () => {
      for (const t of blobRevokeTimersRef.current) clearTimeout(t);
      blobRevokeTimersRef.current = [];
      for (const u of previewBlobRevokeQueueRef.current) {
        if (typeof u === 'string' && u.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(u);
          } catch {
            /* noop */
          }
        }
      }
      previewBlobRevokeQueueRef.current = [];
      for (const url of mergeCacheRef.current.entries.values()) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      }
      mergeCacheRef.current = { fp: '', entries: new Map() };
      const lastPreview = previewBlobUrlRef.current;
      if (lastPreview?.startsWith('blob:')) URL.revokeObjectURL(lastPreview);
    },
    [],
  );

  const handleClearLayerB = useCallback(() => {
    for (const url of mergeCacheRef.current.entries.values()) {
      if (url.startsWith('blob:')) scheduleRevokeBlobUrl(url);
    }
    mergeCacheRef.current = { fp: '', entries: new Map() };
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                layerUrlB: {} as Record<string, string>,
                layerUrlC: {} as Record<string, string>,
                selectedLayer: null,
              },
            }
          : n
      )
    );
    setSelectedLayer(null);
    setBlenderError(null);
  }, [id, setNodes, scheduleRevokeBlobUrl]);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  // Push data to downstream nodes — only after Blender render completes
  // Do NOT push the raw upstream modelUrl; downstream should only receive the
  // fully processed model (outputModelUrl) after the user clicks "Apply Blender Render".
  useEffect(() => {
    const edges = getEdges();
    const downstreamEdges = edges.filter((edge) => edge.source === id);
    if (downstreamEdges.length === 0) return;

    // Only push when Blender has produced output
    if (!data.outputModelUrl) return;
    const outputUrl = data.outputModelUrl; // capture for type narrowing in closure
    const currentLightParams = data.lightParams || { ...DEFAULT_LIGHT_PARAMS };
    const currentLayerFiles = data.layerFiles || [];
    const currentLayerNames = data.layerNames || [];

    setNodes((nds) =>
      nds.map((n) => {
        const edge = downstreamEdges.find((e) => e.target === n.id);
        if (!edge) return n;

        const targetHandle = edge.targetHandle;

        // Push outputModelUrl (Blender output with materials baked in) + lightParams
        // Also forward layerFiles/layerNames from upstream point cloud
        const baseUpdate: Record<string, unknown> = {};
        if (currentLayerFiles.length > 0) baseUpdate.layerFiles = currentLayerFiles;
        if (currentLayerNames.length > 0) baseUpdate.layerNames = currentLayerNames;
        if (data.layerGlbUrls && data.layerGlbUrls.length > 0) {
          baseUpdate.layerGlbUrls = data.layerGlbUrls;
        }

        if (targetHandle === 'model-input') {
          const outType = data.outputModelType || inferModelType(outputUrl) || 'obj';
          return { ...n, data: { ...n.data, modelUrl: outputUrl, inputType: outType as 'glb' | 'obj' | 'ply', lightParams: currentLightParams, ...baseUpdate } };
        } else if (targetHandle === 'obj-input') {
          return { ...n, data: { ...n.data, modelUrl: outputUrl, lightParams: currentLightParams, ...baseUpdate } };
        }

        return n;
      })
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.outputModelUrl, data.layerGlbUrls, data.layerNames, data.layerFiles]);

  // Record Blender render result to history
  const lastRecordedOutputUrl = useRef<string | null>(null);
  useEffect(() => {
    if (data.outputModelUrl && data.outputModelUrl !== lastRecordedOutputUrl.current) {
      lastRecordedOutputUrl.current = data.outputModelUrl;
      recordModelHistory({
        name: `Surface_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`,
        modelUrl: data.outputModelUrl,
        modelType: data.outputModelType || null,
        thumbnailUrl: data.renderUrl || null,
        sourceNode: 'modelSurface',
      });
    }
  }, [data.outputModelUrl, data.outputModelType, data.renderUrl]);

  // Handle OBJ model upload from local file
  const handleObjFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const mainFile = files[0];
      const ext = mainFile.name.split('.').pop()?.toLowerCase();
      const validExts = ['glb', 'gltf', 'fbx', 'obj', 'ply'];
      if (!ext || !validExts.includes(ext)) {
        setBlenderError('Unsupported model format');
        return;
      }

      // Use blob URL for immediate 3D preview, then upload to server
      const previewUrl = URL.createObjectURL(mainFile);
      setObjFileName(mainFile.name);
      setSelectedLayer(null);
      setBlenderError(null);
      setIsUploading(true);

      // Set preview immediately so the user sees the model
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...n.data,
                  modelUrl: previewUrl,
                  selectedLayer: null,
                  blenderError: null,
                  outputModelUrl: null,
                  outputModelType: null,
                },
              }
            : n
        )
      );

      // Upload to server so backend APIs (Blender) can access the file
      // Include companion files (MTL, textures) if selected alongside the OBJ
      const formData = new FormData();
      formData.append('file', mainFile);
      formData.append('type', 'model');

      // Add companion files (MTL, PNG, JPG, etc.) that were selected together
      for (let i = 1; i < files.length; i++) {
        formData.append('companions', files[i]);
      }

      apiFetch('/api/upload-model', { method: 'POST', body: formData })
        .then((res) => res.json())
        .then((result) => {
          if (!result.success) {
            setBlenderError('Model upload failed: ' + (result.error || 'Unknown error'));
            setIsUploading(false);
            return;
          }
          // Replace blob URL with server URL
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, modelUrl: result.url } }
                : n
            )
          );
          setIsUploading(false);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Model upload failed';
          setBlenderError(message);
          setIsUploading(false);
        });
    },
    [id, setNodes, apiFetch]
  );

  // Handle clicking the empty preview placeholder → open OBJ file picker
  const handlePreviewPlaceholderClick = useCallback(() => {
    objFileInputRef.current?.click();
  }, []);

  const handleClearSurfacePreview = useCallback(() => {
    if (blenderProcessing || previewMergeBusy || isUploading) return;
    autoBlenderAbortRef.current?.abort();
    for (const u of previewBlobRevokeQueueRef.current) {
      if (typeof u === 'string' && u.startsWith('blob:')) scheduleRevokeBlobUrl(u);
    }
    previewBlobRevokeQueueRef.current = [];
    for (const url of mergeCacheRef.current.entries.values()) {
      if (url.startsWith('blob:')) scheduleRevokeBlobUrl(url);
    }
    mergeCacheRef.current = { fp: '', entries: new Map() };
    if (previewBlobUrl?.startsWith('blob:')) scheduleRevokeBlobUrl(previewBlobUrl);
    if (data.modelUrl?.startsWith('blob:')) scheduleRevokeBlobUrl(data.modelUrl);
    if (data.outputModelUrl?.startsWith('blob:')) scheduleRevokeBlobUrl(data.outputModelUrl);
    setPreviewBlobUrl(null);
    setPreviewMergeBusy(false);
    setSelectedLayer(null);
    setDetectedLayers([]);
    setLayerParams({});
    setBlenderProcessing(false);
    setBlenderError(null);
    setObjFileName(null);
    setIsUploading(false);
    setIsFullscreen(false);
    prevUpstreamGlbKeyRef.current = '';
    if (objFileInputRef.current) objFileInputRef.current.value = '';
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                modelUrl: null,
                outputModelUrl: null,
                outputModelType: null,
                selectedLayer: null,
                blenderProcessing: false,
                blenderError: null,
                renderUrl: null,
                layerFiles: [] as string[],
                layerNames: [] as string[],
                layerGlbUrls: [] as string[],
                layerUrlA: {} as Record<string, string>,
                layerUrlB: {} as Record<string, string>,
                layerUrlC: {} as Record<string, string>,
                layerParams: {} as Record<string, MaterialParams>,
              },
            }
          : n
      )
    );
  }, [
    blenderProcessing,
    data.modelUrl,
    data.outputModelUrl,
    id,
    isUploading,
    previewBlobUrl,
    previewMergeBusy,
    scheduleRevokeBlobUrl,
    setNodes,
  ]);

  // Handle texture file upload
  const handleTextureUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Use blob URL for immediate preview
      const previewUrl = URL.createObjectURL(file);
      setTextureFileName(file.name);
      setIsUploading(true);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, materialFileName: file.name, materialPreviewUrl: previewUrl } }
            : n
        )
      );

      // Upload to server so backend APIs can access the texture
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', 'texture');

      apiFetch('/api/upload-model', { method: 'POST', body: formData })
        .then((res) => res.json())
        .then((result) => {
          if (!result.success) {
            setBlenderError('Texture upload failed: ' + (result.error || 'Unknown error'));
            setIsUploading(false);
            return;
          }
          // Replace blob URL with server URL
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, materialPreviewUrl: result.url } }
                : n
            )
          );
          setIsUploading(false);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Texture upload failed';
          setBlenderError(message);
          setIsUploading(false);
        });
    },
    [id, setNodes, apiFetch]
  );

  // Update a single param for the selected layer
  const updateParam = useCallback(
    <K extends keyof MaterialParams>(key: K, value: MaterialParams[K]) => {
      if (!selectedLayer) return;
      setLayerParams((prev) => ({
        ...prev,
        [selectedLayer]: {
          ...(prev[selectedLayer] || { ...DEFAULT_MATERIAL_PARAMS }),
          [key]: value,
        },
      }));
    },
    [selectedLayer]
  );

  // Reset current layer params to defaults
  const resetCurrentParams = useCallback(() => {
    if (!selectedLayer) return;
    setLayerParams((prev) => ({
      ...prev,
      [selectedLayer]: { ...DEFAULT_MATERIAL_PARAMS },
    }));
  }, [selectedLayer]);

  // Update light params and persist to node data
  const updateLightParams = useCallback(
    (params: LightParams) => {
      setLightParams(params);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, lightParams: params } } : n
        )
      );
    },
    [id, setNodes]
  );

  // Handle layer click from 3D viewer
  const handleLayerClick = useCallback(
    (layerName: string) => {
      skipAutoBlenderOnceRef.current = true;
      setSelectedLayer(layerName);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, selectedLayer: layerName } } : n
        )
      );
    },
    [id, setNodes]
  );

  // Send material params + model to Blender for rendering
  const sendToBlender = useCallback(() => {
    const gIn = data.layerGlbUrls;
    if (gIn && gIn.length > 0) {
      (async () => {
        for (const u of gIn) {
          if (u.startsWith('blob:')) {
            setBlenderError('A layer file is still uploading, please wait');
            return;
          }
        }
        const layerUrlA = (data.layerUrlA || {}) as Record<string, string>;
        const layerUrlB = (data.layerUrlB || {}) as Record<string, string>;
        const entries = orderedLayerGlbEntries(gIn, layerNames, layerUrlA).filter((e) => isGltfLikeUrl(e.url));
        if (entries.length === 0) {
          setBlenderError('Server merge needs .glb/.gltf per-layer URLs.');
          return;
        }
        const mergeNames = entries.map((e) => e.layerName);
        const mergePaths = mergeNames.map((nm) => layerUrlB[nm] || layerUrlA[nm] || entries.find((e) => e.layerName === nm)!.url);
        for (const p of mergePaths) {
          if (isBlobUrl(p)) {
            setBlenderError('Cannot merge blob URLs on server; wait for uploads to finish');
            return;
          }
        }

        setBlenderProcessing(true);
        setBlenderError(null);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, blenderProcessing: true, blenderError: null } }
              : n
          )
        );
        try {
          const mRes = await apiFetch('/api/merge-glb', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ glbPaths: mergePaths, names: mergeNames }),
          });
          const raw = await mRes.text();
          let merged: { success?: boolean; error?: string; mergedGlbUrl?: string };
          try {
            merged = JSON.parse(raw) as typeof merged;
          } catch {
            throw new Error(
              `merge-glb returned non-JSON (HTTP ${mRes.status}): ${raw.trim().slice(0, 120)}`,
            );
          }
          if (!mRes.ok || !merged.success) {
            throw new Error(merged.error || 'Server merge failed');
          }
          const newModelUrl = merged.mergedGlbUrl as string;
          setBlenderProcessing(false);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      blenderProcessing: false,
                      blenderError: null,
                      outputModelUrl: newModelUrl,
                      outputModelType: 'glb' as const,
                      layerParams,
                    },
                  }
                : n
            )
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Merge failed';
          setBlenderProcessing(false);
          setBlenderError(message);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, blenderProcessing: false, blenderError: message } }
                : n
            )
          );
        }
      })();
      return;
    }

    if (!data.modelUrl) return;

    // Guard: blob URLs are not accessible by server-side APIs
    if (isBlobUrl(data.modelUrl)) {
      setBlenderError('File is uploading, please wait before trying again');
      return;
    }

    // Use selected layer's params for legacy / UI snapshot; per-layer when multi applies full map
    const targetGroup = selectedLayer || 'all';
    const params = selectedLayer
      ? (layerParams[selectedLayer] || { ...DEFAULT_MATERIAL_PARAMS })
      : { ...DEFAULT_MATERIAL_PARAMS };

    const knownLayers: string[] =
      layerNames.length > 0
        ? layerNames
        : detectedLayers.length > 0
          ? detectedLayers
          : selectedLayer
            ? [selectedLayer]
            : [];

    const fullLayerParams: Record<string, MaterialParams> = {};
    for (const n of knownLayers) {
      fullLayerParams[n] = { ...DEFAULT_MATERIAL_PARAMS, ...layerParams[n] };
    }
    const useMultiLayer = Object.keys(fullLayerParams).length > 0;

    setBlenderProcessing(true);
    setBlenderError(null);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, blenderProcessing: true, blenderError: null, layerParams, materialParams: params } }
          : n
      )
    );

    const body: Record<string, unknown> = {
      action: 'apply',
      modelUrl: data.modelUrl,
      textureUrl: data.materialPreviewUrl || undefined,
      lightParams,
      render: true,
    };
    if (useMultiLayer) {
      body.layerParams = fullLayerParams;
    } else {
      body.group = targetGroup;
      body.materialParams = params;
      body.baseColorModified = !!params.base_color_modified;
    }

    apiFetch('/api/blender-material', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => res.json())
      .then((result) => {
        setBlenderProcessing(false);
        if (!result.success) {
          setBlenderError(result.error || 'Blender processing failed');
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, blenderProcessing: false, blenderError: result.error } }
                : n
            )
          );
          return;
        }

        // Update with Blender output model (GLB preferred for embedded textures)
        const newModelUrl = result.glbUrl || result.modelUrl;
        const newModelType = result.glbUrl ? 'glb' as const : (inferModelType(result.modelUrl || '') || 'obj') as 'glb' | 'fbx' | 'obj' | 'ply';
        const newRenderUrl = result.renderUrl || null;

        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    blenderProcessing: false,
                    blenderError: null,
                    outputModelUrl: newModelUrl,
                    outputModelType: newModelType,
                    renderUrl: newRenderUrl,
                    layerParams,
                  },
                }
              : n
          )
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Blender request failed';
        setBlenderProcessing(false);
        setBlenderError(message);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, blenderProcessing: false, blenderError: message } }
              : n
          )
        );
      });
  }, [id, data, selectedLayer, layerParams, layerNames, detectedLayers, setNodes, lightParams, apiFetch]);

  // Helper: RGB array to hex string for color input
  const rgbToHex = (rgb: [number, number, number]): string => {
    const toHex = (v: number) => {
      const clamped = Math.max(0, Math.min(1, v));
      const hex = Math.round(clamped * 255).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
  };

  // Helper: hex string to RGB array
  const hexToRgb = (hex: string): [number, number, number] => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return [0.8, 0.75, 0.7];
    return [
      parseInt(result[1], 16) / 255,
      parseInt(result[2], 16) / 255,
      parseInt(result[3], 16) / 255,
    ];
  };

  /** Merged browser preview already encodes highlight; avoid double dim in viewer */
  const viewerHighlightLayer = hasPerLayerGlbs && previewBlobUrl ? null : selectedLayer;

  const surfaceControlsLocked = blenderProcessing || previewMergeBusy;

  return (
    <div
      style={getNodeFrameStyle(
        'modelSurface',
        blenderProcessing || previewMergeBusy ? 'processing' : blenderError ? 'error' : data.outputModelUrl ? 'done' : 'idle'
      )}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="modelSurface" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'target', id: 'obj-input', label: 'Model', color: '#7a4a55' },
        { type: 'source', id: 'obj-output', label: 'Model', color: '#7a4a55' },
      ]} />
      <div className="p-3 space-y-2">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-400">
            {isUploading ? 'Uploading...' : selectedLayer ? `Selected: ${selectedLayer}` : 'Select layer (buttons or model)'}
          </span>
          <div className="flex items-center gap-1">
            {previewMergeBusy && (
              <span className="text-[9px] text-zinc-500">Merging preview…</span>
            )}
            {blenderProcessing && <StatusBadge status="processing" />}
            {blenderError && <StatusBadge status="error" />}
            {previewModelUrl && (
              <button
                type="button"
                disabled={surfaceControlsLocked}
                onClick={(e) => { e.stopPropagation(); setIsFullscreen(true); }}
                className="flex h-6 w-6 items-center justify-center rounded bg-zinc-700 text-zinc-300 transition-colors hover:bg-zinc-600 disabled:pointer-events-none disabled:opacity-40"
                title="Fullscreen"
              >
                <Maximize2 size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Segmented layer info */}
        {layerFiles.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-zinc-500 uppercase tracking-wider">Layers</span>
              <span className="text-[9px] text-indigo-400">{layerFiles.length}</span>
              <span className="ml-1 text-[9px] text-zinc-600">use layer buttons or click model</span>
            </div>
            {selectedLayer && (
              <div className="flex items-center gap-1">
                <span className="text-[9px] text-zinc-400">Selected:</span>
                <span className="px-1.5 py-0.5 rounded text-[9px] bg-indigo-600 text-white">{selectedLayer}</span>
              </div>
            )}
          </div>
        )}

        {/* Layer name tags — prefer metadata-driven names, fall back to 3D color detection */}
        {(layerNames.length > 0 || detectedLayers.length > 0) && (
          <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Layer selection">
            {(layerNames.length > 0 ? layerNames : detectedLayers).map((layerName: string, idx: number) => {
              const layerColor = LAYER_DISPLAY_COLORS[idx % LAYER_DISPLAY_COLORS.length];
              const isActive = selectedLayer === layerName;
              return (
                <button
                  key={layerName}
                  type="button"
                  aria-pressed={isActive}
                  disabled={surfaceControlsLocked}
                  title={layerName}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] leading-tight text-zinc-200 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 disabled:pointer-events-none disabled:opacity-40 ${isActive ? 'ring-1 ring-white bg-zinc-700' : 'bg-zinc-800 hover:bg-zinc-700'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLayerClick(layerName);
                  }}
                >
                  <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: layerColor }}
                    aria-hidden
                  />
                  {layerName}
                </button>
              );
            })}
            {hasPerLayerGlbs && (
              <button
                type="button"
                disabled={surfaceControlsLocked}
                onClick={(e) => {
                  e.stopPropagation();
                  handleClearLayerB();
                }}
                className="ml-1 rounded px-1.5 py-0.5 text-[9px] text-zinc-400 ring-1 ring-zinc-600 hover:bg-zinc-700 hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-40"
                title="Clear per-layer Blender outputs (url_b); preview returns to merged originals"
              >
                Clear layer renders
              </button>
            )}
          </div>
        )}

        {/* 3D Model preview with layer clicking */}
        <div className="relative h-[140px] overflow-hidden rounded-md border border-dashed border-zinc-600 bg-zinc-900">
          {previewModelUrl ? (
            <InteractiveModelViewer
              modelUrl={previewModelUrl}
              modelType={previewModelType}
              className="h-full w-full"
              onLayerClick={surfaceControlsLocked ? undefined : handleLayerClick}
              onLayersDetected={(layers: string[]) => setDetectedLayers(layers)}
              highlightLayer={viewerHighlightLayer}
              processing={blenderProcessing}
              processingText="Blender rendering..."
              lightParams={lightParams}
              previewMaterialParams={selectedLayer ? currentParams : null}
              previewMaterialLayer={selectedLayer}
              metadataLayerNames={data.layerNames && data.layerNames.length > 0 ? data.layerNames : undefined}
              onSuccessfulModelLoad={handlePreviewGlbLoadSuccess}
            />
          ) : (
            <div
              className={`flex h-full items-center justify-center transition-colors ${surfaceControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-[#5a7068]/50'}`}
              onClick={(e) => {
                e.stopPropagation();
                if (surfaceControlsLocked) return;
                handlePreviewPlaceholderClick();
              }}
            >
              <Upload size={24} className="text-zinc-600" />
            </div>
          )}
          {previewModelUrl && !surfaceControlsLocked && !isUploading && (
            <PreviewClearIconButton onClick={handleClearSurfacePreview} />
          )}
        </div>

        {/* OBJ model file input (hidden) */}
        <input
          ref={objFileInputRef}
          type="file"
          accept=".glb,.gltf,.fbx,.obj,.ply,.mtl,.png,.jpg,.jpeg"
          multiple
          className="hidden"
          onChange={handleObjFileUpload}
        />
        {objFileName && (
          <p className="truncate text-[10px] text-zinc-400">Model: {objFileName}</p>
        )}

        {/* ---- Principled BSDF Material Parameters Panel ---- */}
        {selectedLayer && (
          <div
            className={`space-y-1.5 rounded-md border border-zinc-600/60 bg-zinc-800/80 p-2 ${surfaceControlsLocked ? 'opacity-70' : ''}`}
            aria-busy={surfaceControlsLocked || undefined}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-[#8a9aaa]">
                Principled BSDF
              </span>
              <button
                type="button"
                disabled={surfaceControlsLocked}
                onClick={(e) => { e.stopPropagation(); resetCurrentParams(); }}
                className="flex h-4 w-4 items-center justify-center rounded text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 disabled:pointer-events-none disabled:opacity-40"
                title="Reset params"
              >
                <RotateCcw size={9} />
              </button>
            </div>

            {/* Base Color */}
            <ParamRow label="Base Color">
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={rgbToHex(currentParams.base_color)}
                  disabled={surfaceControlsLocked}
                  onChange={(e) => { e.stopPropagation(); updateParam('base_color', hexToRgb(e.target.value)); updateParam('base_color_modified', true); }}
                  onClick={(e) => e.stopPropagation()}
                  className={`h-5 w-5 rounded border border-zinc-600 bg-transparent nodrag ${surfaceControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                />
                <span className="text-[9px] text-zinc-500 font-mono">
                  {rgbToHex(currentParams.base_color)}
                </span>
              </div>
            </ParamRow>

            {/* Metallic */}
            <ParamRow label="Metallic">
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={currentParams.metallic}
                  disabled={surfaceControlsLocked}
                  onChange={(e) => { e.stopPropagation(); updateParam('metallic', parseFloat(e.target.value)); }}
                  onClick={(e) => e.stopPropagation()}
                  className={`h-1 w-16 accent-[#6a8aaa] nodrag ${surfaceControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                />
                <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
                  {currentParams.metallic.toFixed(2)}
                </span>
              </div>
            </ParamRow>

            {/* Roughness */}
            <ParamRow label="Roughness">
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={currentParams.roughness}
                  disabled={surfaceControlsLocked}
                  onChange={(e) => { e.stopPropagation(); updateParam('roughness', parseFloat(e.target.value)); }}
                  onClick={(e) => e.stopPropagation()}
                  className={`h-1 w-16 accent-[#6a8aaa] nodrag ${surfaceControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                />
                <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
                  {currentParams.roughness.toFixed(2)}
                </span>
              </div>
            </ParamRow>

            {/* Emissive Color */}
            <ParamRow label="Emissive Color">
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={rgbToHex(currentParams.emissive_color)}
                  disabled={surfaceControlsLocked}
                  onChange={(e) => { e.stopPropagation(); updateParam('emissive_color', hexToRgb(e.target.value)); }}
                  onClick={(e) => e.stopPropagation()}
                  className={`h-5 w-5 rounded border border-zinc-600 bg-transparent nodrag ${surfaceControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                />
                <span className="text-[9px] text-zinc-500 font-mono">
                  {rgbToHex(currentParams.emissive_color)}
                </span>
              </div>
            </ParamRow>

            {/* Emissive Strength */}
            <ParamRow label="Emissive Strength">
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.1"
                  value={currentParams.emissive_strength}
                  disabled={surfaceControlsLocked}
                  onChange={(e) => { e.stopPropagation(); updateParam('emissive_strength', parseFloat(e.target.value)); }}
                  onClick={(e) => e.stopPropagation()}
                  className={`h-1 w-16 accent-[#8a6a7a] nodrag ${surfaceControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                />
                <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
                  {currentParams.emissive_strength.toFixed(1)}
                </span>
              </div>
            </ParamRow>

            {/* Alpha */}
            <ParamRow label="Alpha">
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={currentParams.alpha}
                  disabled={surfaceControlsLocked}
                  onChange={(e) => { e.stopPropagation(); updateParam('alpha', parseFloat(e.target.value)); }}
                  onClick={(e) => e.stopPropagation()}
                  className={`h-1 w-16 accent-[#6aaa8a] nodrag ${surfaceControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                />
                <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
                  {currentParams.alpha.toFixed(2)}
                </span>
              </div>
            </ParamRow>

            {/* Normal Scale */}
            <ParamRow label="Normal Scale">
              <div className="flex items-center gap-1.5">
                <input
                  type="range"
                  min="0"
                  max="5"
                  step="0.1"
                  value={currentParams.normal_scale}
                  disabled={surfaceControlsLocked}
                  onChange={(e) => { e.stopPropagation(); updateParam('normal_scale', parseFloat(e.target.value)); }}
                  onClick={(e) => e.stopPropagation()}
                  className={`h-1 w-16 accent-[#8a8a6a] nodrag ${surfaceControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                />
                <span className="w-7 text-right text-[9px] text-zinc-500 font-mono">
                  {currentParams.normal_scale.toFixed(1)}
                </span>
              </div>
            </ParamRow>

            {/* Texture upload */}
            <ParamRow label="Texture Map">
              <div className="flex items-center gap-1.5">
                <input
                  ref={textureInputRef}
                  type="file"
                  accept="image/*,.png,.jpg,.jpeg,.hdr,.exr"
                  className="hidden"
                  disabled={surfaceControlsLocked}
                  onChange={handleTextureUpload}
                />
                <button
                  type="button"
                  disabled={surfaceControlsLocked}
                  onClick={(e) => { e.stopPropagation(); textureInputRef.current?.click(); }}
                  className="flex items-center gap-1 rounded bg-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-300 hover:bg-zinc-600 nodrag disabled:pointer-events-none disabled:opacity-40"
                >
                  <Upload size={8} />
                  {textureFileName ? 'Change' : 'Upload'}
                </button>
                {textureFileName && (
                  <span className="truncate text-[9px] text-zinc-500 max-w-[60px]">{textureFileName}</span>
                )}
              </div>
            </ParamRow>
          </div>
        )}

        {/* Apply: legacy = full Blender; per-layer GLBs = server merge url_b ?? url_a only */}
        {(data.modelUrl || hasPerLayerGlbs) && (
          <button
            onClick={(e) => { e.stopPropagation(); sendToBlender(); }}
            disabled={surfaceControlsLocked || isUploading}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#5a7068]/30 px-3 py-1.5 text-[10px] font-medium text-[#8aaa98] transition-colors hover:bg-[#5a7068]/50 disabled:opacity-50 disabled:cursor-not-allowed nodrag"
          >
            {blenderProcessing ? (
              <>
                <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-[#7a9a88] border-t-[#5a7068]" />
                {hasPerLayerGlbs ? 'Merging on server…' : 'Rendering...'}
              </>
            ) : (
              hasPerLayerGlbs
                ? 'Apply Blender Render (merge layers → downstream)'
                : selectedLayer
                  ? 'Apply Blender Render'
                  : 'Apply Blender Render (All Layers)'
            )}
          </button>
        )}

        {/* ---- Light Settings Panel ---- */}
        {previewModelUrl && (
          <LightControls lightParams={lightParams} onChange={updateLightParams} disabled={surfaceControlsLocked} />
        )}

        {/* Status messages */}
        {isUploading && (
          <p className="text-[10px] text-[#8a8a5a]">File uploading, please wait...</p>
        )}
        {blenderError && (
          <p className="text-[10px] text-[#8a5a5a]">Error: {blenderError}</p>
        )}
        {data.outputModelUrl && !blenderError && (
          <p className="text-[10px] text-[#5a8a6a]">Material applied</p>
        )}
      </div>

      {/* Fullscreen overlay */}
      {isFullscreen && previewModelUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setIsFullscreen(false)}
        >
          <div
            className="relative h-[80vh] w-[80vw] rounded-lg border border-zinc-700 bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setIsFullscreen(false)}
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-700 text-white transition-colors hover:bg-zinc-600"
            >
              <X size={16} />
            </button>
            <InteractiveModelViewer
              modelUrl={previewModelUrl}
              modelType={previewModelType}
              className="h-full w-full"
              onLayerClick={surfaceControlsLocked ? undefined : handleLayerClick}
              highlightLayer={viewerHighlightLayer}
              processing={blenderProcessing}
              processingText="Blender rendering..."
              lightParams={lightParams}
              previewMaterialParams={selectedLayer ? currentParams : null}
              previewMaterialLayer={selectedLayer}
              metadataLayerNames={data.layerNames && data.layerNames.length > 0 ? data.layerNames : undefined}
              onSuccessfulModelLoad={handlePreviewGlbLoadSuccess}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Small helper component for param rows ---- */
function ParamRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[9px] text-zinc-400">{label}</span>
      <div className="flex-1 flex justify-end">{children}</div>
    </div>
  );
}

/* ====================================================================
   9. Mesh Generation Node
   ==================================================================== */
export function ModelGenerationNode({ id, data }: NodeProps<ModelGenerationNodeData>) {
  const { setNodes, getEdges } = useReactFlow();
  const { workflowRunning, apiFetch, ephemeralSessionId } = useWorkflow();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [modelUrl, setModelUrl] = useState<string | null>(data.modelUrl);
  const [inputType, setInputType] = useState<'ply' | 'obj' | 'glb' | 'splat' | null>(data.inputType);
  const [outputUrl, setOutputUrl] = useState<string | null>(data.outputUrl);
  const [outputType, setOutputType] = useState<'glb' | 'fbx' | 'obj' | 'ply' | 'splat' | null>(data.outputType);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [textureUrl, setTextureUrl] = useState<string | null>(data.textureUrl);
  const [meshStatus, setMeshStatus] = useState<'idle' | 'processing' | 'done' | 'error'>(data.meshStatus || 'idle');
  const [outputFormat, setOutputFormat] = useState<'glb' | 'obj' | 'ply'>(data.outputFormat || 'glb');
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);
  const [faceCount, setFaceCount] = useState<number | null>(data.faceCount);
  const [gaussianCount, setGaussianCount] = useState<number | null>(data.gaussianCount);
  const [computeBackend, setComputeBackend] = useState<string | null>(data.computeBackend);
  const [renderUrl, setRenderUrl] = useState<string | null>(data.renderUrl);
  const [isUploading, setIsUploading] = useState(false);
  const [lightParams, setLightParams] = useState<LightParams | null>(data.lightParams || null);
  const [layerGlbUrls, setLayerGlbUrls] = useState<string[]>(data.layerGlbUrls || []);

  // Helper: check if a URL is a browser blob URL (not yet uploaded to server)
  const isBlobUrl = (url: string | null): boolean => !!url && url.startsWith('blob:');

  /** After segmented PLY props update, wait briefly so modelUrl + layerFiles stay in sync before mesh. */
  const [plyMeshInputsReady, setPlyMeshInputsReady] = useState(true);
  useEffect(() => {
    if (inputType !== 'ply') {
      setPlyMeshInputsReady(true);
      return;
    }
    const lf = data.layerFiles?.length ?? 0;
    if (lf === 0) {
      setPlyMeshInputsReady(true);
      return;
    }
    setPlyMeshInputsReady(false);
    const t = window.setTimeout(() => setPlyMeshInputsReady(true), 400);
    return () => window.clearTimeout(t);
  }, [modelUrl, data.layerFiles, data.layerNames, inputType]);

  // Sync from upstream data changes, including global Clear resetting fields to null.
  useEffect(() => {
    if (!data.modelUrl && !data.outputUrl && !data.renderUrl) {
      for (const url of [modelUrl, outputUrl, renderUrl, textureUrl]) {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      }
      setIsUploading(false);
      setIsFullscreen(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
    setModelUrl(data.modelUrl);
    setInputType(data.inputType);
    setTextureUrl(data.textureUrl);
    setMeshStatus(data.meshStatus || 'idle');
    setOutputUrl(data.outputUrl);
    setOutputType(data.outputType);
    setOutputFormat(data.outputFormat || 'glb');
    setErrorMessage(data.errorMessage);
    setFaceCount(data.faceCount);
    setGaussianCount(data.gaussianCount);
    setComputeBackend(data.computeBackend);
    setRenderUrl(data.renderUrl);
    setLightParams(data.lightParams || null);
    setLayerGlbUrls(data.layerGlbUrls || []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.modelUrl, data.inputType, data.textureUrl, data.meshStatus, data.outputUrl, data.outputType, data.outputFormat, data.errorMessage, data.faceCount, data.gaussianCount, data.computeBackend, data.renderUrl, data.lightParams, data.layerGlbUrls]);

  // Push model output to downstream nodes when mesh generation is done
  useEffect(() => {
    if (data.meshStatus === 'done' && data.outputUrl) {
      const downstreamOutputUrl = data.outputUrl;
      const downstreamOutputType = data.outputType;
      if (downstreamOutputType === 'splat') return;
      const edges = getEdges();
      const downstreamEdges = edges.filter(
        (edge) => edge.source === id && edge.sourceHandle === 'output'
      );
      if (downstreamEdges.length > 0) {
        const currentLightParams = lightParams;
        const forwardLayers: Record<string, unknown> = {};
        if (data.layerNames?.length) forwardLayers.layerNames = data.layerNames;
        if (data.layerFiles?.length) forwardLayers.layerFiles = data.layerFiles;
        if (layerGlbUrls.length > 0) forwardLayers.layerGlbUrls = layerGlbUrls;
        setNodes((nds) =>
          nds.map((n) => {
            const edge = downstreamEdges.find((e) => e.target === n.id);
            if (!edge) return n;
            // Route to correct input field based on targetHandle
            const targetHandle = edge.targetHandle;
            if (targetHandle === 'model-input') {
              // Determine input type based on output model type
              const derivedInputType = downstreamOutputType === 'ply' ? 'ply' as const : (downstreamOutputType === 'glb' ? 'glb' as const : 'obj' as const);
              return {
                ...n,
                data: {
                  ...n.data,
                  modelUrl: downstreamOutputUrl,
                  inputType: derivedInputType,
                  ...(currentLightParams ? { lightParams: currentLightParams } : {}),
                  ...forwardLayers,
                },
              };
            } else if (targetHandle === 'texture') {
              return { ...n, data: { ...n.data, textureUrl: downstreamOutputUrl } };
            } else if (targetHandle === 'obj-input') {
              // All nodes now use modelUrl as their input field
              return {
                ...n,
                data: {
                  ...n.data,
                  modelUrl: downstreamOutputUrl,
                  ...(currentLightParams ? { lightParams: currentLightParams } : {}),
                  ...forwardLayers,
                },
              };
            }
            return n;
          })
        );
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.meshStatus, data.outputUrl, data.outputType, layerGlbUrls, data.layerNames, data.layerFiles]);

  // History: once per new output URL. Assets: terminal GLB only, re-evaluated when edges change
  // (separate refs so disconnecting downstream can still publish the same URL to the library).
  const lastHistoryModelUrl = useRef<string | null>(null);
  const lastAssetLibraryModelUrl = useRef<string | null>(null);
  useEffect(() => {
    if (data.meshStatus !== 'done' || !data.outputUrl || isBlobUrl(data.outputUrl)) return;

    const sourceLabel = inputType === 'splat' ? 'Gaussian Splat' : inputType === 'ply' ? 'PLY to Mesh' : inputType === 'glb' ? 'GLB Processing' : 'OBJ Processing';
    const thumbnailUrl = renderUrl || data.renderUrl || null;

    if (data.outputUrl !== lastHistoryModelUrl.current) {
      lastHistoryModelUrl.current = data.outputUrl;
      recordModelHistory({
        name: `${sourceLabel}_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`,
        modelUrl: data.outputUrl,
        modelType: data.outputType || null,
        thumbnailUrl,
        sourceNode: 'modelGeneration',
      });
    }

    const hasDownstream = getEdges().some((e) => e.source === id);
    const isTerminalGlb = data.outputType === 'glb' && !hasDownstream;
    if (isTerminalGlb && data.outputUrl !== lastAssetLibraryModelUrl.current) {
      lastAssetLibraryModelUrl.current = data.outputUrl;
      recordAsset({
        name: `${sourceLabel}_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`,
        assetType: 'model',
        fileUrl: data.outputUrl,
        fileType: 'glb',
        thumbnailUrl,
        sourceNode: 'modelGeneration',
      });
    }
  }, [data.meshStatus, data.outputUrl, data.outputType, inputType, renderUrl, data.renderUrl, id, getEdges]);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const file = files[0];
      const ext = file.name.split('.').pop()?.toLowerCase();
      const validExts = ['glb', 'gltf', 'fbx', 'obj', 'ply'];
      if (!ext || !validExts.includes(ext)) return;

      const resolvedExt = ext === 'gltf' ? 'glb' : (ext as 'glb' | 'fbx' | 'obj' | 'ply');

      // Use blob URL for immediate 3D preview
      const previewUrl = URL.createObjectURL(file);
      setIsUploading(true);

      setOutputUrl(previewUrl);
      setOutputType(resolvedExt);
      setModelUrl(previewUrl);
      setInputType(resolvedExt === 'ply' ? 'ply' : resolvedExt === 'glb' ? 'glb' : 'obj');
      setMeshStatus('done');
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, modelUrl: previewUrl, inputType: resolvedExt === 'ply' ? 'ply' : resolvedExt === 'glb' ? 'glb' : 'obj', outputUrl: previewUrl, outputType: resolvedExt, meshStatus: 'done' as const } }
            : n
        )
      );

      // Upload to server so backend APIs can access the file
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', 'model');

      // Add companion files (MTL, PNG, JPG, etc.) that were selected together
      for (let i = 1; i < files.length; i++) {
        formData.append('companions', files[i]);
      }

      apiFetch('/api/upload-model', { method: 'POST', body: formData })
        .then((res) => res.json())
        .then((result) => {
          if (!result.success) {
            setErrorMessage('Model upload failed: ' + (result.error || 'Unknown error'));
            setIsUploading(false);
            return;
          }
          // Replace blob URL with server URL
          const serverUrl = result.url;
          setModelUrl(serverUrl);
          setOutputUrl(serverUrl);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, modelUrl: serverUrl, outputUrl: serverUrl } }
                : n
            )
          );
          setIsUploading(false);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Model upload failed';
          setErrorMessage(message);
          setIsUploading(false);
        });
    },
    [id, setNodes, apiFetch]
  );

  const handlePreviewClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleClearMeshPreview = useCallback(() => {
    if (meshStatus === 'processing' || isUploading) return;
    for (const url of [modelUrl, outputUrl, renderUrl, textureUrl]) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    setModelUrl(null);
    setInputType(null);
    setOutputUrl(null);
    setOutputType(null);
    setTextureUrl(null);
    setMeshStatus('idle');
    setErrorMessage(null);
    setFaceCount(null);
    setGaussianCount(null);
    setComputeBackend(null);
    setRenderUrl(null);
    setLayerGlbUrls([]);
    setIsUploading(false);
    setIsFullscreen(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                modelUrl: null,
                inputType: null,
                outputUrl: null,
                outputType: null,
                textureUrl: null,
                meshStatus: 'idle' as const,
                errorMessage: null,
                faceCount: null,
                gaussianCount: null,
                computeBackend: null,
                renderUrl: null,
                layerFiles: [] as string[],
                layerNames: [] as string[],
                layerGlbUrls: [] as string[],
              },
            }
          : n
      )
    );
  }, [id, isUploading, meshStatus, modelUrl, outputUrl, renderUrl, setNodes, textureUrl]);

  const handleFormatChange = useCallback(
    (format: 'glb' | 'obj' | 'ply') => {
      setOutputFormat(format);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, outputFormat: format } }
            : n
        )
      );
    },
    [id, setNodes]
  );

  const handleGenerateMesh = useCallback(() => {
    if (!modelUrl) return;
    if (isBlobUrl(modelUrl)) {
      setErrorMessage('File is uploading, please wait...');
      return;
    }
    if (!ephemeralSessionId) {
      setErrorMessage('Workspace session not ready. Please wait or refresh.');
      return;
    }

    const requestedOutputFormat = inputType === 'splat' ? 'glb' : outputFormat;
    if (inputType === 'splat' && outputFormat !== 'glb') {
      setOutputFormat('glb');
    }

    const useLayerPlys =
      (data.layerFiles?.length ?? 0) > 0 &&
      requestedOutputFormat === 'glb' &&
      (inputType === 'ply' || (modelUrl && modelUrl.toLowerCase().split('?')[0].endsWith('.ply')));

    if (useLayerPlys) {
      const plys = data.layerFiles as string[];
      const names = (data.layerNames && data.layerNames.length === plys.length
        ? data.layerNames
        : plys.map((_, i) => `layer_${i}`)) as string[];

      setMeshStatus('processing');
      setErrorMessage(null);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, meshStatus: 'processing' as const, errorMessage: null } }
            : n
        )
      );

      (async () => {
        try {
          const outGlbs: string[] = [];
          let totalFaces = 0;
          for (const ply of plys) {
            if (isBlobUrl(ply)) {
              throw new Error('A layer PLY is still uploading');
            }
            const res = await apiFetch('/api/generate-mesh', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                plyUrl: ply,
                outputFormat: 'glb' as const,
                ephemeralSessionId,
              }),
            });
            const result = await res.json();
            if (!result.success) {
              throw new Error(result.error || 'Failed to start mesh generation for a layer');
            }
            const done = await waitForMeshTask(result.taskId, apiFetch);
            outGlbs.push(done.meshUrl);
            totalFaces += done.faceCount;
          }
          const mergeRes = await apiFetch('/api/merge-glb', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ glbPaths: outGlbs, names }),
          });
          const merged = await mergeRes.json();
          if (!mergeRes.ok || !merged.success) {
            throw new Error(merged.error || 'Failed to merge layer GLBs');
          }
          const mergedUrl = merged.mergedGlbUrl as string;
          setLayerGlbUrls(outGlbs);
          setMeshStatus('done');
          setOutputUrl(mergedUrl);
          setOutputType('glb');
          setModelUrl(mergedUrl);
          setInputType('glb');
          setFaceCount(totalFaces);
          setErrorMessage(null);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      meshStatus: 'done' as const,
                      modelUrl: mergedUrl,
                      inputType: 'glb' as const,
                      outputUrl: mergedUrl,
                      outputType: 'glb' as const,
                      faceCount: totalFaces,
                      layerGlbUrls: outGlbs,
                      layerNames: data.layerNames || names,
                      layerFiles: data.layerFiles || plys,
                      errorMessage: null,
                    },
                  }
                : n
            )
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Per-layer mesh failed';
          setMeshStatus('error');
          setErrorMessage(message);
          setLayerGlbUrls([]);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, meshStatus: 'error' as const, errorMessage: message, layerGlbUrls: [] } }
                : n
            )
          );
        }
      })();
      return;
    }

    setMeshStatus('processing');
    setErrorMessage(null);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, meshStatus: 'processing' as const, errorMessage: null } }
          : n
      )
    );

    apiFetch('/api/generate-mesh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plyUrl: modelUrl, outputFormat: requestedOutputFormat, ephemeralSessionId }),
    })
      .then((res) => res.json())
      .then((result) => {
        if (!result.success) {
          setMeshStatus('error');
          setErrorMessage(result.error || 'Failed to start mesh generation');
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, meshStatus: 'error' as const, errorMessage: result.error || 'Failed to start mesh generation' } }
                : n
            )
          );
          return;
        }

        const taskId = result.taskId;
        let retries = 0;
        const MAX_RETRIES = 60; // 60 * 2s = 2 min max wait
        const poll = () => {
          apiFetch(`/api/mesh-status?taskId=${taskId}`)
            .then((r) => r.json())
            .then((task) => {
              if (task.status === 'processing') {
                setTimeout(poll, 2000);
              } else if (task.status === 'done' && task.result) {
                const { meshUrl, meshFormat, faceCount: fc } = task.result;
                const resolvedType = meshFormat as 'glb' | 'obj' | 'ply';
                const nextInputType = inputType === 'splat'
                  ? 'splat' as const
                  : resolvedType === 'ply'
                    ? 'ply' as const
                    : resolvedType === 'glb'
                      ? 'glb' as const
                      : 'obj' as const;
                setLayerGlbUrls([]);
                setMeshStatus('done');
                setOutputUrl(meshUrl);
                setOutputType(resolvedType);
                setModelUrl(meshUrl);
                setInputType(nextInputType);
                setFaceCount(fc);
                setErrorMessage(null);
                setNodes((nds) =>
                  nds.map((n) =>
                    n.id === id
                      ? {
                          ...n,
                          data: {
                            ...n.data,
                            meshStatus: 'done' as const,
                            modelUrl: meshUrl,
                            inputType: nextInputType,
                            outputUrl: meshUrl,
                            outputType: resolvedType,
                            faceCount: fc,
                            layerGlbUrls: [] as string[],
                            errorMessage: null,
                          },
                        }
                      : n
                  )
                );
              } else if (task.status === 'error') {
                setMeshStatus('error');
                setErrorMessage(task.error || 'Mesh generation failed');
                setNodes((nds) =>
                  nds.map((n) =>
                    n.id === id
                      ? { ...n, data: { ...n.data, meshStatus: 'error' as const, errorMessage: task.error || 'Mesh generation failed' } }
                      : n
                  )
                );
              } else if (task.error && !task.status) {
                // 404 or similar - task may still be initializing, retry
                retries++;
                if (retries < MAX_RETRIES) {
                  setTimeout(poll, 2000);
                } else {
                  setMeshStatus('error');
                  setErrorMessage('Task query timeout');
                  setNodes((nds) =>
                    nds.map((n) =>
                      n.id === id
                        ? { ...n, data: { ...n.data, meshStatus: 'error' as const, errorMessage: 'Task query timeout' } }
                        : n
                    )
                  );
                }
              }
            })
            .catch(() => {
              setMeshStatus('error');
              setErrorMessage('Polling progress failed');
              setNodes((nds) =>
                nds.map((n) =>
                  n.id === id
                    ? { ...n, data: { ...n.data, meshStatus: 'error' as const, errorMessage: 'Polling progress failed' } }
                    : n
                )
              );
            });
        };
        setTimeout(poll, 1000);
      })
      .catch(() => {
        setMeshStatus('error');
        setErrorMessage('Mesh generation request failed');
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, meshStatus: 'error' as const, errorMessage: 'Mesh generation request failed' } }
              : n
          )
        );
      });
  }, [id, modelUrl, outputFormat, setNodes, data.layerFiles, data.layerNames, inputType, apiFetch, ephemeralSessionId]);

  // Process model + PNG: extract textures, metadata, UV completion, apply texture, render
  // Routes to /api/process-glb for GLB input, /api/process-obj for OBJ input
  const handleProcessObj = useCallback(() => {
    if (!modelUrl || !textureUrl) return;
    if (isBlobUrl(modelUrl) || isBlobUrl(textureUrl)) {
      setErrorMessage('File is uploading, please wait...');
      return;
    }
    if (!ephemeralSessionId) {
      setErrorMessage('Workspace session not ready. Please wait or refresh.');
      return;
    }

    setMeshStatus('processing');
    setErrorMessage(null);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, meshStatus: 'processing' as const, errorMessage: null } }
          : n
      )
    );

    // Route to the correct API based on input format
    const isGlb = inputType === 'glb';
    const apiUrl = isGlb ? '/api/process-glb' : '/api/process-obj';
    const requestBody = isGlb
      ? { glbUrl: modelUrl, textureUrl, outputFormat }
      : { modelUrl: modelUrl, textureUrl, outputFormat };

    apiFetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
      .then((res) => res.json())
      .then((result) => {
        if (!result.success) {
          setMeshStatus('error');
          setErrorMessage(result.error || 'Model processing failed');
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? { ...n, data: { ...n.data, meshStatus: 'error' as const, errorMessage: result.error || 'Model processing failed' } }
                : n
            )
          );
          return;
        }

        // Respect outputFormat setting; OBJ is preferred when outputFormat is 'obj'
        const finalModelUrl = outputFormat === 'obj'
          ? (result.modelUrl || result.glbUrl)
          : (result.glbUrl || result.modelUrl);
        const finalModelType = finalModelUrl === result.glbUrl ? 'glb' as const : 'obj' as const;

        setMeshStatus('done');
        setOutputUrl(finalModelUrl);
        setOutputType(finalModelType);
        setModelUrl(finalModelUrl);
        setInputType(finalModelType === 'glb' ? 'glb' : 'obj');
        setFaceCount(result.faceCount);
        setRenderUrl(result.renderUrl);
        setErrorMessage(null);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    meshStatus: 'done' as const,
                    modelUrl: finalModelUrl,
                    inputType: finalModelType === 'glb' ? 'glb' : 'obj',
                    outputUrl: finalModelUrl,
                    outputType: finalModelType,
                    faceCount: result.faceCount,
                    renderUrl: result.renderUrl,
                    errorMessage: null,
                  },
                }
              : n
          )
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Model processing request failed';
        setMeshStatus('error');
        setErrorMessage(message);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, meshStatus: 'error' as const, errorMessage: message } }
              : n
          )
        );
      });
  }, [id, modelUrl, inputType, textureUrl, outputFormat, setNodes, apiFetch, ephemeralSessionId]);

  // Auto-trigger when workflow is running and inputs are ready
  useEffect(() => {
    if (!workflowRunning || meshStatus !== 'idle') return;
    if (!modelUrl) return;

    // Check if PNG handle has a connected edge — if so, wait for textureUrl
    const currentEdges = getEdges();
    const textureEdge = currentEdges.find(
      (e) => e.target === id && e.targetHandle === 'texture'
    );

    if (inputType === 'ply') {
      // PLY input → generate mesh (no PNG dependency)
      handleGenerateMesh();
    } else if (inputType === 'splat') {
      // Splat input → convert Gaussian centers to GLB mesh for downstream Blender/model nodes.
      handleGenerateMesh();
    } else if (inputType === 'obj' || inputType === 'glb') {
      // OBJ/GLB input → needs texture (PNG) if connected
      if (textureEdge && !textureUrl) return; // Wait for PNG
      if (textureUrl) {
        // Model + PNG → merge texture and process
        handleProcessObj();
      } else {
        // Model without PNG → directly set as model preview
        const actualType = inputType || inferModelType(modelUrl) || 'obj';
        setMeshStatus('done');
        setModelUrl(modelUrl);
        setOutputUrl(modelUrl);
        setOutputType(actualType as 'glb' | 'obj' | 'ply');
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, meshStatus: 'done' as const, modelUrl: modelUrl, inputType: actualType as 'glb' | 'obj' | 'ply', outputUrl: modelUrl, outputType: actualType as 'glb' | 'obj' | 'ply' } }
              : n
          )
        );
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowRunning, modelUrl, inputType, textureUrl, meshStatus]);

  const viewerModelType = outputType === 'splat' ? null : outputType;

  return (
    <div
      style={getNodeFrameStyle('modelGeneration', meshStatus)}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="modelGeneration" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'target', id: 'model-input', label: 'Model', color: '#7a4a55' },
        { type: 'target', id: 'texture', label: 'Material', color: '#aa8a5a' },
        { type: 'source', id: 'output', label: 'Model', color: '#7a4a55' },
      ]} />
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-400">
            {outputUrl ? (outputType === 'splat' ? 'SPLAT Source' : outputType?.toUpperCase() + ' Model') : 'Mesh Preview'}
          </span>
          <div className="flex items-center gap-1">
            {meshStatus === 'processing' && <StatusBadge status="processing" />}
            {meshStatus === 'error' && <StatusBadge status="error" />}
            {outputUrl && (
              <button
                onClick={() => setIsFullscreen(true)}
                className="flex h-6 w-6 items-center justify-center rounded bg-zinc-700 text-zinc-300 transition-colors hover:bg-zinc-600"
                title="Fullscreen"
              >
                <Maximize2 size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Preview area */}
        <div
          className="relative h-[140px] cursor-pointer overflow-hidden rounded-md border border-dashed border-zinc-600 bg-zinc-900 transition-colors hover:border-[#8a5a66]/50 nodrag nopan"
          onClick={handlePreviewClick}
        >
          {!outputUrl && !renderUrl ? (
            <div className="flex h-full items-center justify-center text-zinc-600">
              <Upload size={24} />
            </div>
          ) : outputUrl && outputType === 'splat' ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Sparkles size={28} className="text-[#b9a7ff]" />
              <span className="text-[11px] font-medium text-[#c6b8ff]">3D Gaussian splat ready</span>
              <span className="text-[10px] text-zinc-400">
                {gaussianCount ? `${gaussianCount.toLocaleString()} gaussians` : '3DGS PLY'}
              </span>
              {computeBackend && (
                <span className="text-[10px] text-zinc-500">{computeBackend}</span>
              )}
            </div>
          ) : outputUrl ? (
            <ModelViewer
              modelUrl={outputUrl}
              modelType={viewerModelType}
              className="h-full w-full"
            />
          ) : renderUrl && meshStatus === 'done' ? (
            <DynamicPreviewImage
              src={renderUrl}
              alt="Model render"
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : null}
          {meshStatus === 'processing' && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/70 z-10">
              <div className="flex items-center gap-2 text-xs text-[#9a6a74]">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#7a4a55] border-t-[#9a6a74]" />
                {inputType === 'splat' ? 'Converting splat to GLB...' : 'Generating mesh...'}
              </div>
            </div>
          )}
          {isUploading && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/70 z-10">
              <div className="flex items-center gap-2 text-xs text-[#8a7e5a]">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#6a5e3a] border-t-[#8a7e5a]" />
                File uploading...
              </div>
            </div>
          )}
          {(outputUrl || renderUrl) && meshStatus !== 'processing' && !isUploading && (
            <PreviewDownloadIconButton
              onClick={() => {
                const url = outputUrl ?? renderUrl!;
                const ext = outputUrl
                  ? outputType === 'splat'
                    ? '.ply'
                    : outputType != null
                    ? `.${outputType}`
                    : extFromPathname(outputUrl, '.glb')
                  : extFromPathname(renderUrl!, '.png');
                const name = buildPreviewDownloadFilename(data.label, id, ext);
                void downloadFromUrl(url, name).catch(() => {
                  /* download may fail on CORS */
                });
              }}
            />
          )}
          {(modelUrl || outputUrl || renderUrl) && meshStatus !== 'processing' && !isUploading && (
            <PreviewClearIconButton onClick={handleClearMeshPreview} />
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".glb,.gltf,.fbx,.obj,.ply"
          className="hidden"
          onChange={handleFileUpload}
        />

        {/* Generate mesh from point cloud or OBJ input */}
        {modelUrl && inputType === 'ply' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-400 whitespace-nowrap">Output format</span>
              <div className="flex gap-1">
                {(['glb', 'obj', 'ply'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => handleFormatChange(fmt)}
                    className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                      outputFormat === fmt
                        ? 'bg-[#7a4a55]/30 text-[#9a6a74]'
                        : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'
                    }`}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={handleGenerateMesh}
              disabled={meshStatus === 'processing' || isUploading || !plyMeshInputsReady}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#7a4a55]/20 px-3 py-1.5 text-xs text-[#9a6a74] transition-colors hover:bg-[#7a4a55]/30 disabled:opacity-50"
            >
              <Box size={12} />
              {meshStatus === 'processing' ? 'Generating...' : meshStatus === 'done' && outputUrl ? 'Regenerate Mesh' : 'Generate Mesh'}
            </button>
          </div>
        )}

        {modelUrl && inputType === 'splat' && (
          <button
            onClick={handleGenerateMesh}
            disabled={meshStatus === 'processing' || isUploading}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#6f5aa8]/20 px-3 py-1.5 text-xs text-[#c6b8ff] transition-colors hover:bg-[#6f5aa8]/30 disabled:opacity-50"
          >
            <Box size={12} />
            {meshStatus === 'processing' ? 'Converting...' : meshStatus === 'done' && outputUrl ? 'Regenerate GLB' : 'Convert Splat to GLB'}
          </button>
        )}

        {/* Process OBJ/GLB + PNG: texture extraction, UV completion, metadata, rendering */}
        {modelUrl && (inputType === 'obj' || inputType === 'glb') && textureUrl && (
          <button
            onClick={handleProcessObj}
            disabled={meshStatus === 'processing' || isUploading}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#8a5a66]/20 px-3 py-1.5 text-xs text-[#9a6a74] transition-colors hover:bg-[#8a5a66]/30 disabled:opacity-50"
          >
            <Layers size={12} />
            {meshStatus === 'processing' ? 'Processing...' : meshStatus === 'done' && renderUrl ? 'Re-process' : inputType === 'glb' ? 'Process GLB' : 'Process OBJ'}
          </button>
        )}

        {/* Status info */}
        {meshStatus === 'error' && errorMessage && (
          <p className="text-[10px] text-[#8a5a5a]">
            Generation failed: {errorMessage}
          </p>
        )}
        {faceCount !== null && faceCount > 0 && meshStatus === 'done' && (
          <p className="text-[10px] text-[#5a8a6a]">
            {faceCount.toLocaleString()} faces
          </p>
        )}
        {renderUrl && meshStatus === 'done' && (
          <p className="text-[10px] text-[#5a8a6a]">
            Render generated
          </p>
        )}
        {modelUrl && inputType === 'splat' && meshStatus !== 'processing' && (
          <p className="text-[10px] text-[#7f70c7]">
            Ready (Splat → GLB)
          </p>
        )}
        {modelUrl && inputType === 'ply' && !outputUrl && meshStatus !== 'processing' && plyMeshInputsReady && (
          <p className="text-[10px] text-zinc-500">
            Ready (PLY)
          </p>
        )}
        {modelUrl && inputType === 'ply' && !plyMeshInputsReady && (data.layerFiles?.length ?? 0) > 0 && (
          <p className="text-[10px] text-zinc-500">
            Syncing layer data…
          </p>
        )}
        {modelUrl && (inputType === 'obj' || inputType === 'glb') && !textureUrl && meshStatus !== 'processing' && (
          <p className="text-[10px] text-zinc-500">
            Ready ({inputType?.toUpperCase()}){' - Needs PNG material'}
          </p>
        )}
        {modelUrl && (inputType === 'obj' || inputType === 'glb') && textureUrl && meshStatus !== 'processing' && !renderUrl && (
          <p className="text-[10px] text-zinc-500">
            Ready ({inputType?.toUpperCase()} + PNG)
          </p>
        )}
      </div>

      {/* Fullscreen Dialog */}
      {isFullscreen && (renderUrl || outputUrl) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setIsFullscreen(false)}
        >
          <div
            className="relative h-[85vh] w-[85vw] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
              <span className="text-sm font-medium text-white">
                Mesh Preview - {renderUrl ? 'Render' : outputType === 'splat' ? 'SPLAT' : outputType?.toUpperCase()}
              </span>
              <button
                onClick={() => setIsFullscreen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-700 text-zinc-300 transition-colors hover:bg-zinc-600"
              >
                <X size={14} />
              </button>
            </div>
            <div className="h-[calc(85vh-52px)] w-full">
              {renderUrl ? (
                <DynamicPreviewImage
                  src={renderUrl}
                  alt="Model render"
                  className="h-full w-full object-contain"
                  draggable={false}
                />
              ) : outputUrl && outputType === 'splat' ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <Sparkles size={42} className="text-[#b9a7ff]" />
                  <span className="text-sm font-medium text-[#c6b8ff]">3D Gaussian splat asset</span>
                  <span className="text-xs text-zinc-400">
                    {gaussianCount ? `${gaussianCount.toLocaleString()} gaussians` : '3DGS-compatible PLY'}
                  </span>
                  {computeBackend && (
                    <span className="text-xs text-zinc-500">{computeBackend}</span>
                  )}
                </div>
              ) : outputUrl ? (
                <ModelViewer
                  modelUrl={outputUrl}
                  modelType={viewerModelType}
                  className="h-full w-full"
                  lightParams={lightParams || undefined}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
