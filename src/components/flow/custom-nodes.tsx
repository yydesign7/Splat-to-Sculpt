'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Handle, Position, useReactFlow, type NodeProps, type Node } from '@xyflow/react';
import { X, Upload, FolderOpen, Maximize2, MonitorPlay, Video, Film, Box, Check, RotateCcw, StickyNote, Download, Sparkles, Orbit, Brush, Eraser } from 'lucide-react';
import { getNodeConfig, getNodeVisualTheme, NODE_WIDTH, VIDEO_PREVIEW_NODE_WIDTH } from '@/lib/node-config';
import { mergeLayerGlbsInBrowser, isGltfLikeUrl, type LayerGlbEntry } from '@/lib/browser-merge-glb';
import { inferModelTypeFromUrl as inferModelType } from '@/lib/infer-model-type-from-url';
import { selectMeshGenerationAssetCandidate } from '@/lib/mesh-asset-publish-policy';
import { selectModelCleanupMode } from '@/lib/model-cleanup-mode';
import { resolveUploadedVideoServerPath, type RecordedAssetResponse } from '@/lib/uploaded-video-asset';
import { useWorkflow } from '@/lib/workflow-context';
import { DEFAULT_COMFY_VIDEO_PRESET } from '@/lib/comfyui-video-preset';
import type { ComfyVideoPreset, ComfyVideoRunSettings } from '@/lib/comfyui-workflow';
import dynamic from 'next/dynamic';
import { DynamicPreviewImage } from './DynamicPreviewImage';

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
}): Promise<RecordedAssetResponse | null> {
  try {
    const response = await fetch('/api/asset-library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return await response.json() as RecordedAssetResponse;
  } catch {
    // Silently fail — asset recording is non-critical
    return null;
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
}>;

type ModelOrganizeNodeData = Node<{
  label: string;
  modelUrl: string | null;
  outputUrl: string | null;
  outputType: 'glb' | 'fbx' | 'obj' | 'ply' | null;
  isFullscreen: boolean;
  organizeStatus: 'idle' | 'organizing' | 'done' | 'error';
  errorMessage: string | null;
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

type ComfyStatus = 'idle' | 'processing' | 'done' | 'error';

type ComfyVideoData = Record<string, unknown> & {
  label: string;
  modelUrl: string | null;
  videoUrl: string | null;
  videoName: string | null;
  comfyStatus: ComfyStatus;
  progressText: string | null;
  errorMessage: string | null;
  promptId: string | null;
  comfyInput3dDir: string | null;
  detectedInputDir: string | null;
  detectedOutputDir: string | null;
  detectedInput3dDir: string | null;
  comfyOnline: boolean | null;
  comfyVersion: string | null;
} & ComfyVideoPreset;

type ComfyVideoSettingsUpdates = Partial<ComfyVideoPreset> & {
  comfyInput3dDir?: string | null;
};

type ComfyVideoNodeData = Node<ComfyVideoData>;

type SeedancePackStatusResult = {
  success?: boolean;
  ready?: boolean;
  installed?: boolean;
  loaded?: boolean;
  customNodesDir?: string | null;
  workflowsDir?: string | null;
  missingCustomNodeFolders?: string[];
  missingWorkflowFiles?: string[];
  missingNodeTypes?: string[];
  error?: string;
};

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
  layerNames: string[];  // Layer names from Mesh Gen geometry segmentation metadata
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
  meshStatus: 'idle' | 'processing' | 'done' | 'error';
  outputFormat: 'glb' | 'obj' | 'ply';
  errorMessage: string | null;
  faceCount: number | null;
  gaussianCount: number | null;
  computeBackend: string | null;
  renderUrl: string | null;
  lightParams: LightParams | null;
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
  modelOrganize: <Eraser size={14} />,
  comfyVideo: <Sparkles size={14} />,
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
  const { setNodes } = useReactFlow();
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
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, targetFrameCount: val } } : n
          )
        );
      }
    },
    [id, setNodes]
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
          const uploadedVideoName = typeof result.videoName === 'string' ? result.videoName : file.name;
          const assetResponse = await recordAsset({
            name: uploadedVideoName || 'uploaded-video',
            assetType: 'video',
            fileUrl: videoServerPath,
            fileType: 'mp4',
            thumbnailUrl,
            sourceNode: 'videoUpload',
          });
          const publishedVideoServerPath = resolveUploadedVideoServerPath(videoServerPath, assetResponse);

          setNodes((nds) =>
            nds.map((n) =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      uploadStatus: 'done',
                      uploadError: null,
                      videoServerPath: publishedVideoServerPath,
                    },
                  }
                : n
            )
          );
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
    [id, setNodes, apiFetch]
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
  const { apiFetch, runSingleNode } = useWorkflow();
  const [localFrames, setLocalFrames] = useState<string[]>(data.frames || []);
  const [status, setStatus] = useState<'idle' | 'extracting' | 'done' | 'error'>(data.status || 'idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);

  useEffect(() => { setLocalFrames(data.frames || []); }, [data.frames]);
  useEffect(() => { setStatus(data.status || 'idle'); }, [data.status]);
  useEffect(() => { setErrorMessage(data.errorMessage); }, [data.errorMessage]);

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

  const handleExtractFrames = useCallback(() => {
    if (!data.videoServerPath) return;
    void resolveFrameCount();
    void runSingleNode(id);
  }, [id, data.videoServerPath, resolveFrameCount, runSingleNode]);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  const handleOpenOutputFolder = useCallback(() => {
    if (!data.outputFolder) return;
    setErrorMessage(null);
    apiFetch('/api/open-ephemeral-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderType: 'frames', folderId: data.outputFolder }),
    })
      .then(async (res) => {
        const result = await res.json().catch(() => ({}));
        if (!res.ok || !result.success) {
          throw new Error(typeof result.error === 'string' ? result.error : 'Failed to open frames folder');
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to open frames folder';
        setErrorMessage(message);
      });
  }, [apiFetch, data.outputFolder]);

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
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={handleOpenOutputFolder}
              title={`frames/${data.outputFolder}`}
              className="nodrag nopan flex w-full min-w-0 max-w-full items-center justify-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
            >
              <FolderOpen size={10} className="shrink-0" />
              <span className="min-w-0 truncate text-center">
                frames/{data.outputFolder}
              </span>
            </button>
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

/* ========== Layer display colors used for geometry-layer selection ========== */
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
  const { apiFetch, ephemeralSessionId } = useWorkflow();
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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [plyUploading, setPlyUploading] = useState(false);
  const deviceDetectionStartedRef = useRef(false);
  const publishedSplatAssetKeyRef = useRef(data.status === 'done' && data.splatUrl ? data.splatUrl : null);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.framePaths, data.sourcePlyUrl, data.splatUrl, data.gaussianCount, data.status, data.progressText, data.progressStep, data.errorMessage, data.trainingIterations, data.currentTrainingIteration, data.maxTrainingIterations, data.activeTaskId, data.deviceType, data.computeBackend, data.trainingMode, data.targetPlyType, data.trueTrainingAvailable, data.trueTrainingUnavailableReason]);

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
    if (status !== 'done' || !splatUrl || publishedSplatAssetKeyRef.current === splatUrl) return;
    publishedSplatAssetKeyRef.current = splatUrl;
    void (async () => {
      const thumbnailUrl = await createAssetThumbnail({
        fileUrl: splatUrl,
        ephemeralSessionId,
      });
      await recordAsset({
        name: 'Gaussian splat',
        assetType: 'splat',
        fileUrl: splatUrl,
        fileType: 'splat-ply',
        thumbnailUrl,
        sourceNode: 'gaussianSplat',
      });
    })();
  }, [ephemeralSessionId, splatUrl, status]);

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
              },
            }
          : n
      )
    );
  }, [id, plyUploading, setNodes, status]);

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
   5. Model Organize Node
   ==================================================================== */
export function ModelOrganizeNode({ id, data }: NodeProps<ModelOrganizeNodeData>) {
  const { setNodes } = useReactFlow();
  const { apiFetch, runSingleNode } = useWorkflow();
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

  // Run through the centralized workflow runner; the node keeps only UI/display state.
  const handleOrganize = useCallback(() => {
    const cleanupMode = selectModelCleanupMode({ modelUrl, layerGlbUrls: data.layerGlbUrls });
    if (cleanupMode === 'none' || modelUrl?.startsWith('blob:') || data.layerGlbUrls?.some((url) => url.startsWith('blob:'))) {
      setErrorMessage('File is uploading, please wait...');
      return;
    }
    void runSingleNode(id);
  }, [id, modelUrl, data.layerGlbUrls, runSingleNode]);

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
                layerNames: [] as string[],
                layerGlbUrls: [] as string[],
              },
            }
          : n
      )
    );
  }, [id, isUploading, modelUrl, organizeStatus, outputUrl, setNodes]);

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
   6. ComfyUI Video Gen Node
   ==================================================================== */
export function ComfyVideoNode({ id, data }: NodeProps<ComfyVideoNodeData>) {
  const { setNodes } = useReactFlow();
  const { runSingleNode } = useWorkflow();
  const [modelUrl, setModelUrl] = useState<string | null>(data.modelUrl);
  const [videoUrl, setVideoUrl] = useState<string | null>(data.videoUrl);
  const [videoName, setVideoName] = useState<string | null>(data.videoName);
  const [comfyStatus, setComfyStatus] = useState<ComfyStatus>(data.comfyStatus || 'idle');
  const [progressText, setProgressText] = useState<string | null>(data.progressText);
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);
  const [promptId, setPromptId] = useState<string | null>(data.promptId);
  const [comfyOnline, setComfyOnline] = useState<boolean | null>(data.comfyOnline);
  const [comfyVersion, setComfyVersion] = useState<string | null>(data.comfyVersion);
  const [detectedInputDir, setDetectedInputDir] = useState<string | null>(data.detectedInputDir);
  const [detectedOutputDir, setDetectedOutputDir] = useState<string | null>(data.detectedOutputDir);
  const [detectedInput3dDir, setDetectedInput3dDir] = useState<string | null>(data.detectedInput3dDir);
  const [comfyInput3dDir, setComfyInput3dDir] = useState<string>(data.comfyInput3dDir || '');
  const [seedancePackStatus, setSeedancePackStatus] = useState<SeedancePackStatusResult | null>(null);
  const [seedanceInstalling, setSeedanceInstalling] = useState(false);
  const [seedanceMessage, setSeedanceMessage] = useState<string | null>(null);
  const publishedComfyAssetKeyRef = useRef(data.comfyStatus === 'done' && data.videoUrl ? data.videoUrl : null);

  const [comfyUrl, setComfyUrl] = useState(data.comfyUrl || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl);
  const [prompt, setPrompt] = useState(data.prompt || DEFAULT_COMFY_VIDEO_PRESET.prompt);
  const [videoResolution, setVideoResolution] = useState(data.videoResolution || DEFAULT_COMFY_VIDEO_PRESET.videoResolution);
  const [ratio, setRatio] = useState(data.ratio || DEFAULT_COMFY_VIDEO_PRESET.ratio);
  const [duration, setDuration] = useState(data.duration || DEFAULT_COMFY_VIDEO_PRESET.duration);
  const [generateAudio, setGenerateAudio] = useState(data.generateAudio ?? DEFAULT_COMFY_VIDEO_PRESET.generateAudio);
  const [seed, setSeed] = useState(data.seed ?? DEFAULT_COMFY_VIDEO_PRESET.seed);
  const [watermark, setWatermark] = useState(data.watermark ?? DEFAULT_COMFY_VIDEO_PRESET.watermark);
  const [sceneSelection, setSceneSelection] = useState(data.sceneSelection || DEFAULT_COMFY_VIDEO_PRESET.sceneSelection);
  const [renderResolution, setRenderResolution] = useState(data.renderResolution || DEFAULT_COMFY_VIDEO_PRESET.renderResolution);
  const [background, setBackground] = useState(data.background || DEFAULT_COMFY_VIDEO_PRESET.background);
  const [cameraElevation, setCameraElevation] = useState(data.cameraElevation ?? DEFAULT_COMFY_VIDEO_PRESET.cameraElevation);
  const [framePadding, setFramePadding] = useState(data.framePadding ?? DEFAULT_COMFY_VIDEO_PRESET.framePadding);
  const [renderEngine, setRenderEngine] = useState(data.renderEngine || DEFAULT_COMFY_VIDEO_PRESET.renderEngine);
  const [forceRender, setForceRender] = useState(data.forceRender ?? DEFAULT_COMFY_VIDEO_PRESET.forceRender);

  useEffect(() => { setModelUrl(data.modelUrl); }, [data.modelUrl]);
  useEffect(() => { setVideoUrl(data.videoUrl); }, [data.videoUrl]);
  useEffect(() => { setVideoName(data.videoName); }, [data.videoName]);
  useEffect(() => { setComfyStatus(data.comfyStatus || 'idle'); }, [data.comfyStatus]);
  useEffect(() => { setProgressText(data.progressText); }, [data.progressText]);
  useEffect(() => { setErrorMessage(data.errorMessage); }, [data.errorMessage]);
  useEffect(() => { setPromptId(data.promptId); }, [data.promptId]);
  useEffect(() => { setComfyOnline(data.comfyOnline); }, [data.comfyOnline]);
  useEffect(() => { setComfyVersion(data.comfyVersion); }, [data.comfyVersion]);
  useEffect(() => { setDetectedInputDir(data.detectedInputDir); }, [data.detectedInputDir]);
  useEffect(() => { setDetectedOutputDir(data.detectedOutputDir); }, [data.detectedOutputDir]);
  useEffect(() => { setDetectedInput3dDir(data.detectedInput3dDir); }, [data.detectedInput3dDir]);
  useEffect(() => { setComfyInput3dDir(data.comfyInput3dDir || ''); }, [data.comfyInput3dDir]);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  const isBlobUrl = (url: string | null): boolean => !!url && url.startsWith('blob:');

  const commitSettings = useCallback((updates: ComfyVideoSettingsUpdates) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, ...updates } }
          : n
      )
    );
  }, [id, setNodes]);

  const collectSettings = useCallback((): ComfyVideoRunSettings => ({
    comfyUrl,
    comfyInput3dDir: comfyInput3dDir.trim() || undefined,
    model: data.model || DEFAULT_COMFY_VIDEO_PRESET.model,
    prompt,
    videoResolution,
    ratio,
    duration,
    generateAudio,
    seed,
    watermark,
    sceneSelection,
    renderResolution,
    background,
    cameraElevation,
    framePadding,
    renderEngine,
    forceRender,
    filenamePrefix: data.filenamePrefix || DEFAULT_COMFY_VIDEO_PRESET.filenamePrefix,
    format: data.format || DEFAULT_COMFY_VIDEO_PRESET.format,
    codec: data.codec || DEFAULT_COMFY_VIDEO_PRESET.codec,
  }), [
    background,
    cameraElevation,
    comfyInput3dDir,
    comfyUrl,
    data.codec,
    data.filenamePrefix,
    data.format,
    data.model,
    duration,
    forceRender,
    framePadding,
    generateAudio,
    prompt,
    ratio,
    renderEngine,
    renderResolution,
    sceneSelection,
    seed,
    videoResolution,
    watermark,
  ]);

  const applyPreset = useCallback((preset: ComfyVideoPreset) => {
    setComfyUrl(preset.comfyUrl);
    setPrompt(preset.prompt);
    setVideoResolution(preset.videoResolution);
    setRatio(preset.ratio);
    setDuration(preset.duration);
    setGenerateAudio(preset.generateAudio);
    setSeed(preset.seed);
    setWatermark(preset.watermark);
    setSceneSelection(preset.sceneSelection);
    setRenderResolution(preset.renderResolution);
    setBackground(preset.background);
    setCameraElevation(preset.cameraElevation);
    setFramePadding(preset.framePadding);
    setRenderEngine(preset.renderEngine);
    setForceRender(preset.forceRender);
    commitSettings(preset);
  }, [commitSettings]);

  const syncFromPreset = useCallback(() => {
    fetch('/api/comfy-video-preset')
      .then((res) => res.json())
      .then((result) => {
        if (!result.success) throw new Error(result.error || 'Preset sync failed');
        applyPreset(result.preset as ComfyVideoPreset);
        setErrorMessage(null);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Preset sync failed';
        setErrorMessage(message);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, errorMessage: message, comfyStatus: 'error' as const } } : n
          )
        );
      });
  }, [applyPreset, id, setNodes]);

  const updateRunState = useCallback((updates: Partial<ComfyVideoNodeData['data']>) => {
    setNodes((nds) =>
      nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...updates } } : n))
    );
  }, [id, setNodes]);

  const refreshSeedancePackStatus = useCallback(() => {
    const params = new URLSearchParams({ comfyUrl: comfyUrl.trim() || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl });
    return fetch(`/api/comfy-seedance-status?${params.toString()}`)
      .then((res) => res.json())
      .then((result: SeedancePackStatusResult) => {
        setSeedancePackStatus(result);
        if (result.success === false && typeof result.error === 'string') {
          setSeedanceMessage(result.error);
        } else if (result.ready) {
          setSeedanceMessage(null);
        }
        return result;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Seedance pack status check failed';
        const result: SeedancePackStatusResult = { success: false, error: message };
        setSeedancePackStatus(result);
        setSeedanceMessage(message);
        return result;
      });
  }, [comfyUrl]);

  const refreshComfyStatus = useCallback(() => {
    const params = new URLSearchParams({ comfyUrl: comfyUrl.trim() || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl });
    fetch(`/api/comfy-video-status?${params.toString()}`)
      .then((res) => res.json())
      .then((result) => {
        const online = result.online === true;
        const nextVersion = typeof result.version === 'string' ? result.version : null;
        const nextInputDir = typeof result.detectedInputDir === 'string' ? result.detectedInputDir : null;
        const nextOutputDir = typeof result.detectedOutputDir === 'string' ? result.detectedOutputDir : null;
        const nextInput3dDir = typeof result.detectedInput3dDir === 'string' ? result.detectedInput3dDir : null;
        const nextError = online ? null : (typeof result.error === 'string' ? result.error : 'ComfyUI disconnected');
        const nextComfyStatus = online && comfyStatus === 'error' && !videoUrl ? 'idle' : online ? comfyStatus : 'error';

        setComfyOnline(online);
        setComfyVersion(nextVersion);
        setDetectedInputDir(nextInputDir);
        setDetectedOutputDir(nextOutputDir);
        setDetectedInput3dDir(nextInput3dDir);
        setErrorMessage(nextError);
        setComfyStatus(nextComfyStatus);
        if (online) {
          void refreshSeedancePackStatus();
        } else {
          setSeedancePackStatus(null);
          setSeedanceMessage(null);
        }

        updateRunState({
          comfyOnline: online,
          comfyVersion: nextVersion,
          detectedInputDir: nextInputDir,
          detectedOutputDir: nextOutputDir,
          detectedInput3dDir: nextInput3dDir,
          errorMessage: nextError,
          comfyStatus: nextComfyStatus,
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'ComfyUI status check failed';
        setComfyOnline(false);
        setErrorMessage(message);
        updateRunState({
          comfyOnline: false,
          comfyVersion: null,
          detectedInputDir: null,
          detectedOutputDir: null,
          detectedInput3dDir: null,
          errorMessage: message,
          comfyStatus: 'error',
        });
        setSeedancePackStatus(null);
        setSeedanceMessage(null);
      });
  }, [comfyStatus, comfyUrl, refreshSeedancePackStatus, updateRunState, videoUrl]);

  const installSeedancePack = useCallback(() => {
    setSeedanceInstalling(true);
    setSeedanceMessage(null);
    fetch('/api/install-comfy-seedance-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comfyUrl: comfyUrl.trim() || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl }),
    })
      .then((res) => res.json())
      .then((result) => {
        if (!result.success) {
          throw new Error(typeof result.error === 'string' ? result.error : 'Seedance pack installation failed');
        }
        setSeedanceMessage(result.restartRequired ? 'Installed. Restart ComfyUI, then Check again.' : 'Seedance pack already installed.');
        return refreshSeedancePackStatus();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Seedance pack installation failed';
        setSeedanceMessage(message);
      })
      .finally(() => {
        setSeedanceInstalling(false);
      });
  }, [comfyUrl, refreshSeedancePackStatus]);

  useEffect(() => {
    refreshComfyStatus();
  }, [refreshComfyStatus]);

  useEffect(() => {
    if (comfyStatus !== 'done' || !videoUrl || publishedComfyAssetKeyRef.current === videoUrl) return;
    publishedComfyAssetKeyRef.current = videoUrl;
    void recordAsset({
      name: videoName || 'ComfyUI Video',
      assetType: 'render-video',
      fileUrl: videoUrl,
      fileType: 'mp4',
      sourceNode: 'comfyVideo',
    });
  }, [comfyStatus, videoName, videoUrl]);

  const handleGenerate = useCallback(() => {
    const inputModelUrl = modelUrl;
    if (!inputModelUrl || isBlobUrl(inputModelUrl)) {
      const message = 'Model file unavailable, please wait for upload';
      setErrorMessage(message);
      updateRunState({ errorMessage: message, comfyStatus: 'error' });
      return;
    }
    if (seedancePackStatus && seedancePackStatus.ready === false) {
      const message = 'Seedance ComfyUI pack is missing or ComfyUI needs restart. Install it and check again before generating.';
      setErrorMessage(message);
      updateRunState({ errorMessage: message, comfyStatus: 'error' });
      return;
    }
    commitSettings(collectSettings());
    void runSingleNode(id);
  }, [collectSettings, commitSettings, id, modelUrl, runSingleNode, seedancePackStatus, updateRunState]);

  const visualStatus: NodeVisualStatus =
    comfyStatus === 'processing' ? 'processing' : comfyStatus === 'done' ? 'done' : comfyStatus === 'error' ? 'error' : 'idle';
  const effectiveInput3dDir = comfyInput3dDir.trim() || detectedInput3dDir;
  const connectionLabel = comfyOnline === true ? 'connected' : comfyOnline === false ? 'disconnected' : 'checking';
  const seedanceReady = seedancePackStatus?.ready === true;
  const seedanceInstalled = seedancePackStatus?.installed === true;
  const seedanceLoaded = seedancePackStatus?.loaded === true;
  const seedancePackLabel = seedanceReady
    ? seedanceInstalled ? 'ready' : 'ready, workflow missing'
    : seedancePackStatus
      ? seedanceInstalled && !seedanceLoaded
        ? 'restart needed'
        : 'missing'
      : 'unchecked';
  const missingSeedanceItems = [
    ...(seedancePackStatus?.missingCustomNodeFolders || []),
    ...(seedancePackStatus?.missingWorkflowFiles || []),
    ...(seedancePackStatus?.missingNodeTypes || []),
  ];

  return (
    <div
      style={getNodeFrameStyle('comfyVideo', visualStatus)}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="comfyVideo" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'target', id: 'model-input', label: 'Model', color: '#7a4a55' },
        { type: 'source', id: 'video-output', label: 'Video', color: '#5f8f74' },
      ]} />
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <StatusBadge status={visualStatus} />
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); syncFromPreset(); }}
            className="nodrag flex h-7 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/70 px-2 text-[10px] text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            <RotateCcw size={11} />
            Sync preset
          </button>
        </div>

        <PreviewBox className="h-[88px]" placeholder="Waiting for model">
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center">
            {comfyStatus === 'processing' ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#5f8f74] border-t-transparent" />
            ) : videoUrl ? (
              <Sparkles size={20} className="text-[#bde6ce]" />
            ) : (
              <Box size={20} className="text-zinc-500" />
            )}
            <span className="max-w-full truncate text-[10px] text-zinc-400">
              {progressText || (videoUrl ? 'ComfyUI video ready' : modelUrl ? 'Model ready' : 'Waiting for model input')}
            </span>
            {promptId && <span className="max-w-full truncate text-[9px] text-zinc-500">Prompt {promptId}</span>}
          </div>
        </PreviewBox>

        <label className="block space-y-1">
          <span className="text-[10px] text-zinc-400">ComfyUI URL</span>
          <input
            value={comfyUrl}
            onChange={(event) => {
              setComfyUrl(event.target.value);
              commitSettings({ comfyUrl: event.target.value });
            }}
            className="nodrag w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200 outline-none focus:border-[#5f8f74]"
          />
        </label>

        <details className="nodrag rounded-md border border-zinc-700/70 bg-zinc-900/50 px-2 py-1 text-[10px] text-zinc-400">
          <summary className="cursor-pointer">
            <span className="ml-1 inline-flex w-[calc(100%-1rem)] items-center justify-between gap-2 align-middle">
              <span>
                ComfyUI: <span className={comfyOnline ? 'text-[#bde6ce]' : 'text-[#8a5a5a]'}>{connectionLabel}</span>
                {comfyVersion ? <span className="text-zinc-500"> · {comfyVersion}</span> : null}
              </span>
              <button
                type="button"
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); refreshComfyStatus(); }}
                className="nodrag rounded border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-300 hover:bg-zinc-800"
              >
                Check
              </button>
            </span>
          </summary>
          <div className="mt-2 space-y-0.5">
            <div className="truncate text-zinc-500" title={effectiveInput3dDir || undefined}>
              Input/3D: {effectiveInput3dDir || 'Not detected'}
            </div>
            <div className="truncate text-zinc-500" title={detectedOutputDir || undefined}>
              Output: {detectedOutputDir || 'Not detected'}
            </div>
            {detectedInputDir ? (
              <div className="truncate text-zinc-500" title={detectedInputDir}>
                Input: {detectedInputDir}
              </div>
            ) : null}
          </div>
        </details>

        <details className="nodrag rounded-md border border-zinc-700/70 bg-zinc-900/50 px-2 py-1 text-[10px] text-zinc-400">
          <summary className="cursor-pointer">
            <span className="ml-1 inline-flex w-[calc(100%-1rem)] items-center justify-between gap-2 align-middle">
              <span>
                Seedance pack:{' '}
                <span className={seedanceReady ? 'text-[#bde6ce]' : seedancePackStatus ? 'text-[#d6b36a]' : 'text-zinc-500'}>
                  {seedancePackLabel}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); void refreshSeedancePackStatus(); }}
                  disabled={comfyOnline !== true}
                  className="nodrag rounded border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Check
                </button>
                {!seedanceInstalled && (
                  <button
                    type="button"
                    onClick={(event) => { event.preventDefault(); event.stopPropagation(); installSeedancePack(); }}
                    disabled={comfyOnline !== true || seedanceInstalling}
                    className="nodrag rounded border border-[#5f8f74]/60 bg-[#5f8f74]/20 px-1.5 py-0.5 text-[9px] text-[#bde6ce] hover:bg-[#5f8f74]/30 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {seedanceInstalling ? 'Installing' : 'Install'}
                  </button>
                )}
              </span>
            </span>
          </summary>
          <div className="mt-2 space-y-0.5">
            {seedancePackStatus?.customNodesDir ? (
              <div className="truncate text-zinc-500" title={seedancePackStatus.customNodesDir}>
                Custom nodes: {seedancePackStatus.customNodesDir}
              </div>
            ) : null}
            {seedancePackStatus?.workflowsDir ? (
              <div className="truncate text-zinc-500" title={seedancePackStatus.workflowsDir}>
                Workflows: {seedancePackStatus.workflowsDir}
              </div>
            ) : null}
            {missingSeedanceItems.length > 0 ? (
              <div className="truncate text-[#d6b36a]" title={missingSeedanceItems.join(', ')}>
                Missing: {missingSeedanceItems.join(', ')}
              </div>
            ) : null}
            {seedanceMessage ? (
              <div className="text-[#d6b36a]">
                {seedanceMessage}
              </div>
            ) : null}
          </div>
        </details>

        <label className="block space-y-1">
          <span className="text-[10px] text-zinc-400">Prompt</span>
          <textarea
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              commitSettings({ prompt: event.target.value });
            }}
            rows={4}
            className="nodrag nowheel w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] leading-4 text-zinc-200 outline-none focus:border-[#5f8f74]"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[10px] text-zinc-400">Video</span>
            <select
              value={videoResolution}
              onChange={(event) => {
                setVideoResolution(event.target.value);
                commitSettings({ videoResolution: event.target.value });
              }}
              className="nodrag w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
            >
              <option value="480p">480p</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-zinc-400">Ratio</span>
            <select
              value={ratio}
              onChange={(event) => {
                setRatio(event.target.value);
                commitSettings({ ratio: event.target.value });
              }}
              className="nodrag w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
            >
              {['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'].map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-zinc-400">Duration</span>
            <input
              type="number"
              min={4}
              max={15}
              value={duration}
              onChange={(event) => {
                const next = Number(event.target.value);
                setDuration(next);
                commitSettings({ duration: next });
              }}
              className="nodrag w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-zinc-400">Seed</span>
            <input
              type="number"
              value={seed}
              onChange={(event) => {
                const next = Number(event.target.value);
                setSeed(next);
                commitSettings({ seed: next });
              }}
              className="nodrag w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex items-center gap-2 text-[10px] text-zinc-300">
            <input
              type="checkbox"
              checked={generateAudio}
              onChange={(event) => {
                setGenerateAudio(event.target.checked);
                commitSettings({ generateAudio: event.target.checked });
              }}
              className="nodrag"
            />
            Audio
          </label>
          <label className="flex items-center gap-2 text-[10px] text-zinc-300">
            <input
              type="checkbox"
              checked={watermark}
              onChange={(event) => {
                setWatermark(event.target.checked);
                commitSettings({ watermark: event.target.checked });
              }}
              className="nodrag"
            />
            Watermark
          </label>
        </div>

        <details className="nodrag rounded-md border border-zinc-700/70 bg-zinc-900/50 px-2 py-1">
          <summary className="cursor-pointer text-[10px] text-zinc-400">Render preset</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="col-span-2 space-y-1">
              <span className="text-[10px] text-zinc-500">Override input/3d path</span>
              <input
                value={comfyInput3dDir}
                placeholder={detectedInput3dDir || 'Use auto-detected path'}
                onChange={(event) => {
                  const next = event.target.value;
                  setComfyInput3dDir(next);
                  commitSettings({ comfyInput3dDir: next || null });
                }}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200 outline-none focus:border-[#5f8f74]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500">Image res</span>
              <select
                value={renderResolution}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setRenderResolution(next);
                  commitSettings({ renderResolution: next });
                }}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
              >
                {[512, 768, 1024, 1536].map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500">Background</span>
              <select
                value={background}
                onChange={(event) => {
                  setBackground(event.target.value);
                  commitSettings({ background: event.target.value });
                }}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
              >
                {['深灰影棚', '纯黑', '纯白', '透明'].map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500">Camera elev.</span>
              <input
                type="number"
                value={cameraElevation}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setCameraElevation(next);
                  commitSettings({ cameraElevation: next });
                }}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500">Padding</span>
              <input
                type="number"
                step={0.01}
                value={framePadding}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setFramePadding(next);
                  commitSettings({ framePadding: next });
                }}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
              />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-[10px] text-zinc-500">Render engine</span>
              <select
                value={renderEngine}
                onChange={(event) => {
                  setRenderEngine(event.target.value);
                  commitSettings({ renderEngine: event.target.value });
                }}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
              >
                <option value="Eevee（快速）">Eevee（快速）</option>
                <option value="Cycles（高质量）">Cycles（高质量）</option>
              </select>
            </label>
            <label className="col-span-2 flex items-center gap-2 text-[10px] text-zinc-300">
              <input
                type="checkbox"
                checked={forceRender}
                onChange={(event) => {
                  setForceRender(event.target.checked);
                  commitSettings({ forceRender: event.target.checked });
                }}
              />
              Force render
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-[10px] text-zinc-500">Scene</span>
              <select
                value={sceneSelection}
                onChange={(event) => {
                  setSceneSelection(event.target.value);
                  commitSettings({ sceneSelection: event.target.value });
                }}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200"
              >
                <option value="场景全部对象">场景全部对象</option>
                <option value="自动选择靠近原点的单件">自动选择靠近原点的单件</option>
              </select>
            </label>
          </div>
        </details>

        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); handleGenerate(); }}
          disabled={comfyStatus === 'processing' || !modelUrl || isBlobUrl(modelUrl)}
          className="nodrag flex w-full items-center justify-center gap-1.5 rounded-md bg-[#5f8f74]/30 px-3 py-1.5 text-[10px] font-medium text-[#bde6ce] transition-colors hover:bg-[#5f8f74]/45 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {comfyStatus === 'processing' ? (
            <>
              <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-[#bde6ce] border-t-transparent" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles size={11} />
              Generate ComfyUI video
            </>
          )}
        </button>

        {videoUrl && <p className="truncate text-[10px] text-[#5f8f74]">{videoName || 'ComfyUI Video'}</p>}
        {errorMessage && <p className="text-[10px] text-[#8a5a5a]">{errorMessage}</p>}
      </div>
    </div>
  );
}

/* ====================================================================
   7. Video Preview Node
   ==================================================================== */
export function VideoPreviewNode({ id, data }: NodeProps<VideoPreviewNodeData>) {
  const { setNodes } = useReactFlow();
  const { runSingleNode } = useWorkflow();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(data.videoUrl);
  const [videoName, setVideoName] = useState<string | null>(data.videoName);
  const [modelUrl, setModelUrl] = useState<string | null>(data.modelUrl);
  const [videoGenerating, setVideoGenerating] = useState(data.videoGenerating || false);
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const publishedRotationAssetKeyRef = useRef(
    data.videoName === 'Rotation Preview' && data.videoUrl ? data.videoUrl : null,
  );

  // Sync upstream data changes to local state
  useEffect(() => { setVideoUrl(data.videoUrl); }, [data.videoUrl]);
  useEffect(() => { setVideoName(data.videoName); }, [data.videoName]);
  useEffect(() => { setModelUrl(data.modelUrl); }, [data.modelUrl]);
  useEffect(() => { setVideoGenerating(data.videoGenerating || false); }, [data.videoGenerating]);
  useEffect(() => { setErrorMessage(data.errorMessage); }, [data.errorMessage]);

  useEffect(() => {
    if (videoGenerating || videoName !== 'Rotation Preview' || !videoUrl || publishedRotationAssetKeyRef.current === videoUrl) {
      return;
    }
    publishedRotationAssetKeyRef.current = videoUrl;
    void recordAsset({
      name: 'Rotation preview video',
      assetType: 'render-video',
      fileUrl: videoUrl,
      fileType: 'mp4',
      sourceNode: 'videoPreview',
    });
  }, [videoGenerating, videoName, videoUrl]);

  const handleDelete = useCallback(() => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
  }, [id, setNodes]);

  // Helper: check if a URL is a browser blob URL (not yet uploaded to server)
  const isBlobUrl = (url: string | null): boolean => !!url && url.startsWith('blob:');

  // Generate 360° rotation video through the centralized workflow runner.
  const handleGenerateVideo = useCallback(() => {
    const inputModelUrl = modelUrl;
    if (!inputModelUrl || isBlobUrl(inputModelUrl)) {
      setErrorMessage('Model file unavailable, please wait for upload');
      return;
    }
    void runSingleNode(id);
  }, [id, modelUrl, runSingleNode]);

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
        { type: 'target', id: 'video-input', label: 'Video', color: '#5f8f74' },
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
  const { setNodes } = useReactFlow();
  const { apiFetch, runSingleNode } = useWorkflow();
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

  const layerNames = useMemo(() => data.layerNames || [], [data.layerNames]);
  const hasPerLayerGlbs = (data.layerGlbUrls?.length ?? 0) > 0;
  const layerUrlBForPreview = (data.layerUrlB || {}) as Record<string, string>;
  const hasLayerPreviewOverrides = Object.values(layerUrlBForPreview).some(Boolean);
  const shouldUseLayerMergedPreview = hasPerLayerGlbs && (!!selectedLayer || hasLayerPreviewOverrides);

  /** Browser-only merged GLB preview for per-layer GLB workflow */
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const previewBlobUrlRef = useRef<string | null>(null);
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
  const selectedLayerRef = useRef(selectedLayer);
  const lightParamsRef = useRef(lightParams);
  const surfaceApiRef = useRef({
    materialPreviewUrl: null as string | null,
    layerUrlA: {} as Record<string, string>,
    dataLightParams: null as LightParams | null,
  });
  /** Skip one auto-Blender debounce after layer selection (only fire on material edits). */
  const skipAutoBlenderOnceRef = useRef(false);
  const autoBlenderAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    previewBlobUrlRef.current = previewBlobUrl;
  }, [previewBlobUrl]);

  useEffect(() => {
    layerParamsRef.current = layerParams;
  }, [layerParams]);

  useEffect(() => {
    selectedLayerRef.current = selectedLayer;
  }, [selectedLayer]);

  useEffect(() => {
    lightParamsRef.current = lightParams;
  }, [lightParams]);

  useEffect(() => {
    surfaceApiRef.current = {
      materialPreviewUrl: data.materialPreviewUrl,
      layerUrlA: (data.layerUrlA || {}) as Record<string, string>,
      dataLightParams: data.lightParams || null,
    };
  }, [data.materialPreviewUrl, data.layerUrlA, data.lightParams]);

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
      (data.layerGlbUrls?.length ?? 0) === 0;
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

  // Send material params + model through the centralized workflow runner.
  const sendToBlender = useCallback(() => {
    const gIn = data.layerGlbUrls;
    if (gIn && gIn.length > 0) {
      for (const u of gIn) {
        if (u.startsWith('blob:')) {
          setBlenderError('A layer file is still uploading, please wait');
          return;
        }
      }
    } else if (!data.modelUrl) {
      return;
    } else if (isBlobUrl(data.modelUrl)) {
      setBlenderError('File is uploading, please wait before trying again');
      return;
    }
    const params = selectedLayer
      ? (layerParams[selectedLayer] || { ...DEFAULT_MATERIAL_PARAMS })
      : { ...DEFAULT_MATERIAL_PARAMS };
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, blenderError: null, layerParams, materialParams: params, lightParams } }
          : n
      )
    );
    void runSingleNode(id);
  }, [id, data.layerGlbUrls, data.modelUrl, selectedLayer, layerParams, setNodes, lightParams, runSingleNode]);

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
        {(data.layerGlbUrls?.length ?? 0) > 0 && (
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-zinc-500 uppercase tracking-wider">Layers</span>
              <span className="text-[9px] text-indigo-400">{data.layerGlbUrls?.length ?? 0}</span>
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

        {/* Apply: legacy = full Blender; per-layer GLBs = server merge url_b ?? url_a only */}
        {(data.modelUrl || hasPerLayerGlbs) && (
          <button
            onClick={(e) => { e.stopPropagation(); sendToBlender(); }}
            disabled={surfaceControlsLocked || isUploading}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#5a7068]/30 px-3 py-1.5 text-[10px] font-medium text-[#8aaa98] transition-colors hover:bg-[#5a7068]/50 disabled:cursor-not-allowed disabled:opacity-50 nodrag"
          >
            {blenderProcessing && (
              <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-[#7a9a88] border-t-[#5a7068]" />
            )}
            Apply Blender Render
          </button>
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
  const { setNodes } = useReactFlow();
  const { apiFetch, ephemeralSessionId, runSingleNode } = useWorkflow();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [modelUrl, setModelUrl] = useState<string | null>(data.modelUrl);
  const [inputType, setInputType] = useState<'ply' | 'obj' | 'glb' | 'splat' | null>(data.inputType);
  const [outputUrl, setOutputUrl] = useState<string | null>(data.outputUrl);
  const [outputType, setOutputType] = useState<'glb' | 'fbx' | 'obj' | 'ply' | 'splat' | null>(data.outputType);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [meshStatus, setMeshStatus] = useState<'idle' | 'processing' | 'done' | 'error'>(data.meshStatus || 'idle');
  const [outputFormat, setOutputFormat] = useState<'glb' | 'obj' | 'ply'>(data.outputFormat || 'glb');
  const [errorMessage, setErrorMessage] = useState<string | null>(data.errorMessage);
  const [faceCount, setFaceCount] = useState<number | null>(data.faceCount);
  const [gaussianCount, setGaussianCount] = useState<number | null>(data.gaussianCount);
  const [computeBackend, setComputeBackend] = useState<string | null>(data.computeBackend);
  const [renderUrl, setRenderUrl] = useState<string | null>(data.renderUrl);
  const [isUploading, setIsUploading] = useState(false);
  const [lightParams, setLightParams] = useState<LightParams | null>(data.lightParams || null);
  const [, setLayerGlbUrls] = useState<string[]>(data.layerGlbUrls || []);

  // Helper: check if a URL is a browser blob URL (not yet uploaded to server)
  const isBlobUrl = (url: string | null): boolean => !!url && url.startsWith('blob:');

  // Sync from upstream data changes, including global Clear resetting fields to null.
  useEffect(() => {
    if (!data.modelUrl && !data.outputUrl && !data.renderUrl) {
      for (const url of [modelUrl, outputUrl, renderUrl]) {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      }
      setIsUploading(false);
      setIsFullscreen(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
    setModelUrl(data.modelUrl);
    setInputType(data.inputType);
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
  }, [data.modelUrl, data.inputType, data.meshStatus, data.outputUrl, data.outputType, data.outputFormat, data.errorMessage, data.faceCount, data.gaussianCount, data.computeBackend, data.renderUrl, data.lightParams, data.layerGlbUrls]);

  // Publish reusable mesh model outputs once.
  const lastAssetLibraryModelUrl = useRef<string | null>(null);
  useEffect(() => {
    if (data.meshStatus !== 'done' || !data.outputUrl || isBlobUrl(data.outputUrl)) return;

    const sourceLabel = inputType === 'splat' ? 'Gaussian Splat' : inputType === 'ply' ? 'PLY to Mesh' : inputType === 'glb' ? 'GLB Processing' : 'OBJ Processing';
    const thumbnailUrl = renderUrl || data.renderUrl || null;

    const assetCandidate = selectMeshGenerationAssetCandidate({
      outputType: data.outputType,
      outputUrl: data.outputUrl,
      layerGlbUrls: data.layerGlbUrls,
      layerNames: data.layerNames,
    });
    const assetFingerprint = assetCandidate?.kind === 'merge-layers'
      ? `layers:${assetCandidate.layerGlbUrls.join('|')}`
      : assetCandidate?.fileUrl || null;
    if (assetCandidate && assetFingerprint && assetFingerprint !== lastAssetLibraryModelUrl.current) {
      lastAssetLibraryModelUrl.current = assetFingerprint;
      void (async () => {
        let assetFileUrl = assetCandidate.fileUrl;
        let assetFileType = assetCandidate.fileType;
        if (assetCandidate.kind === 'merge-layers') {
          const mergeResponse = await apiFetch('/api/merge-glb', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              glbPaths: assetCandidate.layerGlbUrls,
              names: assetCandidate.layerNames,
            }),
          });
          const merged = await mergeResponse.json();
          if (!mergeResponse.ok || !merged.success || typeof merged.mergedGlbUrl !== 'string') {
            throw new Error(typeof merged.error === 'string' ? merged.error : 'Failed to merge layer GLBs for Assets');
          }
          assetFileUrl = merged.mergedGlbUrl;
          assetFileType = 'glb';
        }

        const modelThumbnailUrl = thumbnailUrl ?? await createAssetThumbnail({
          fileUrl: assetFileUrl!,
          ephemeralSessionId,
        });
        await recordAsset({
          name: `${sourceLabel}_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`,
          assetType: 'model',
          fileUrl: assetFileUrl!,
          fileType: assetFileType,
          thumbnailUrl: modelThumbnailUrl,
          sourceNode: 'modelGeneration',
        });
      })().catch((error: unknown) => {
        console.error('[modelGeneration] Failed to publish mesh asset:', error);
      });
    }
  }, [apiFetch, data.meshStatus, data.outputUrl, data.outputType, data.layerGlbUrls, data.layerNames, inputType, renderUrl, data.renderUrl, ephemeralSessionId]);

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
    for (const url of [modelUrl, outputUrl, renderUrl]) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    setModelUrl(null);
    setInputType(null);
    setOutputUrl(null);
    setOutputType(null);
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
                meshStatus: 'idle' as const,
                errorMessage: null,
                faceCount: null,
                gaussianCount: null,
                computeBackend: null,
                renderUrl: null,
                layerNames: [] as string[],
                layerGlbUrls: [] as string[],
              },
            }
          : n
      )
    );
  }, [id, isUploading, meshStatus, modelUrl, outputUrl, renderUrl, setNodes]);

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

    if (inputType === 'splat' && outputFormat !== 'glb') {
      setOutputFormat('glb');
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, outputFormat: 'glb' as const } } : n
        )
      );
    }
    void runSingleNode(id);
  }, [id, modelUrl, outputFormat, setNodes, inputType, ephemeralSessionId, runSingleNode]);

  const viewerModelType = outputType === 'splat' ? null : outputType;

  return (
    <div
      style={getNodeFrameStyle('modelGeneration', meshStatus)}
      className={NODE_FRAME_CLASS_NAME}
    >
      <NodeHeader type="modelGeneration" onDelete={handleDelete} />
      <HandleBar ports={[
        { type: 'target', id: 'model-input', label: 'Model', color: '#7a4a55' },
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
              disabled={meshStatus === 'processing' || isUploading}
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
        {modelUrl && inputType === 'ply' && !outputUrl && meshStatus !== 'processing' && (
          <p className="text-[10px] text-zinc-500">
            Ready (PLY)
          </p>
        )}
        {modelUrl && (inputType === 'obj' || inputType === 'glb') && meshStatus !== 'processing' && (
          <p className="text-[10px] text-zinc-500">
            Ready ({inputType?.toUpperCase()})
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
