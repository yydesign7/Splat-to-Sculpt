'use client';

import { useState, useEffect, useCallback, type DragEvent } from 'react';
import {
  ChevronRight,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Video,
  Film,
  Palette,
  Box,
  MonitorPlay,
  Trash2,
  RefreshCw,
  FolderOpen,
  FileVideo,
  FileArchive,
  FileBox,
  Copy,
  GitBranch,
  Pencil,
  Check,
  StickyNote,
  ArrowRight,
  Orbit,
  Brush,
  Eraser,
} from 'lucide-react';
import { getNodeVisualTheme, NODE_TYPE_CONFIGS } from '@/lib/node-config';
import { isListedSidebarAsset } from '@/lib/asset-sidebar-policy';
import { DynamicPreviewImage } from './DynamicPreviewImage';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onLoadWorkflow: (entry: { nodes: unknown[]; edges: unknown[] }) => void;
}

export type AssetType = 'video' | 'pointcloud' | 'splat' | 'model' | 'render-video';

export interface AssetEntry {
  id: string;
  name: string;
  assetType: AssetType;
  fileUrl: string;
  fileType: string;
  thumbnailUrl: string | null;
  sourceNode: string;
  createdAt: string;
}

export interface WorkflowEntry {
  id: string;
  name: string;
  nodes: unknown[];
  edges: unknown[];
  createdAt: string;
  updatedAt: string;
  readonly?: boolean;
  preset?: boolean;
}

type TabKey = 'nodes' | 'assets' | 'workflows';

const NODE_ICONS: Record<string, React.ReactNode> = {
  videoUpload: <Video size={17} />,
  frameExtraction: <Film size={17} />,
  gaussianSplat: <Orbit size={17} />,
  material: <Palette size={17} />,
  modelOrganize: <Eraser size={17} />,
  videoPreview: <MonitorPlay size={17} />,
  modelSurface: <Brush size={17} />,
  modelGeneration: <Box size={17} />,
  stickyNote: <StickyNote size={17} />,
};

/** Map assetType to icon */
const ASSET_TYPE_ICONS: Record<AssetType, React.ReactNode> = {
  video: <FileVideo size={17} />,
  pointcloud: <FileArchive size={17} />,
  splat: <Orbit size={17} />,
  model: <FileBox size={17} />,
  'render-video': <FileVideo size={17} />,
};

function AssetVisual({ item }: { item: AssetEntry }) {
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null);
  const hasPreview = Boolean(item.thumbnailUrl);
  const isVideoPreview = item.assetType === 'video' || item.assetType === 'render-video';
  const previewTop = previewRect
    ? Math.min(
        Math.max(previewRect.top + previewRect.height / 2, 96),
        typeof window === 'undefined' ? previewRect.top + previewRect.height / 2 : window.innerHeight - 96
      )
    : 0;

  const openPreview = (target: HTMLElement) => {
    if (!hasPreview) return;
    setPreviewRect(target.getBoundingClientRect());
  };

  const smallVisual = item.thumbnailUrl ? (
    <span className="flex h-6 w-9 shrink-0 overflow-hidden rounded border border-zinc-700/70 bg-zinc-950">
      <DynamicPreviewImage
        src={item.thumbnailUrl}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
        draggable={false}
      />
    </span>
  ) : (
    <span className="flex h-6 w-9 shrink-0 items-center justify-center rounded border border-zinc-700/60 bg-zinc-800/60 text-zinc-500">
      {ASSET_TYPE_ICONS[item.assetType]}
    </span>
  );

  return (
    <span
      className="relative flex h-6 w-9 shrink-0 items-center justify-center"
      onMouseEnter={(event) => openPreview(event.currentTarget)}
      onMouseLeave={() => setPreviewRect(null)}
      onFocus={(event) => openPreview(event.currentTarget)}
      onBlur={() => setPreviewRect(null)}
    >
      {smallVisual}
      {previewRect && item.thumbnailUrl && (
        <span
          className="pointer-events-none fixed z-[80] rounded-lg border border-zinc-700 bg-zinc-950/95 p-1.5 shadow-2xl shadow-black/50"
          style={{
            left: previewRect.right + 10,
            top: previewTop,
            transform: 'translateY(-50%)',
          }}
        >
          {isVideoPreview ? (
            <video
              src={`${item.fileUrl}#t=0.6`}
              muted
              playsInline
              preload="metadata"
              className="block max-h-[150px] max-w-[220px] rounded bg-zinc-950 object-contain"
            />
          ) : (
            <DynamicPreviewImage
              src={item.thumbnailUrl}
              alt=""
              className="block h-32 w-48 rounded bg-zinc-950 object-contain"
              draggable={false}
            />
          )}
        </span>
      )}
    </span>
  );
}

function NodeTypeDescription({ description }: { description: string }) {
  const [inputType, outputType] = description.split(' -> ');

  if (!inputType || !outputType) {
    return <span className="truncate text-[11px] text-zinc-400">{description}</span>;
  }

  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] text-zinc-400">
      <span className="truncate">{inputType}</span>
      <ArrowRight size={11} strokeWidth={2} className="shrink-0 text-zinc-500" aria-hidden="true" />
      <span className="truncate">{outputType}</span>
    </span>
  );
}

/** Format ISO date string to a localized short format */
function formatDate(isoString: string): string {
  const d = new Date(isoString);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${min}`;
}

export default function Sidebar({ collapsed, onToggle, onLoadWorkflow }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('nodes');
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowEntry[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [bulkDeletingAssets, setBulkDeletingAssets] = useState(false);
  const [bulkDeletingWorkflows, setBulkDeletingWorkflows] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const deletableWorkflowCount = workflows.filter((wf) => !wf.readonly).length;

  const fetchAssets = useCallback(async () => {
    setAssetsLoading(true);
    try {
      const res = await fetch('/api/asset-library');
      const data = await res.json();
      if (data.success) {
        setAssets((data.entries as AssetEntry[]).filter(isListedSidebarAsset));
      }
    } catch {
      // Silently fail
    } finally {
      setAssetsLoading(false);
    }
  }, []);

  const fetchWorkflows = useCallback(async () => {
    setWorkflowsLoading(true);
    try {
      const res = await fetch('/api/workflow-library');
      const data = await res.json();
      if (data.success) {
        setWorkflows(data.entries);
      }
    } catch {
      // Silently fail
    } finally {
      setWorkflowsLoading(false);
    }
  }, []);

  // Fetch assets when the asset tab is activated
  useEffect(() => {
    if (activeTab === 'assets') {
      fetchAssets();
    }
  }, [activeTab, fetchAssets]);

  // Fetch workflows when the workflows tab is activated
  useEffect(() => {
    if (activeTab === 'workflows') {
      fetchWorkflows();
    }
  }, [activeTab, fetchWorkflows]);

  // Also refresh on window focus
  useEffect(() => {
    const onFocus = () => {
      if (activeTab === 'assets') fetchAssets();
      if (activeTab === 'workflows') fetchWorkflows();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [activeTab, fetchAssets, fetchWorkflows]);

  // Refresh workflows when a new workflow is saved
  useEffect(() => {
    const onWorkflowSaved = () => {
      fetchWorkflows();
    };
    window.addEventListener('workflow-library-changed', onWorkflowSaved);
    return () => window.removeEventListener('workflow-library-changed', onWorkflowSaved);
  }, [fetchWorkflows]);

  const handleDeleteAsset = useCallback(async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/asset-library?id=${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setAssets((prev) => prev.filter((e) => e.id !== id));
      }
    } catch {
      // Silently fail
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleCopyUrl = useCallback(async (id: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Fallback: silently fail
    }
  }, []);

  const handleDeleteWorkflow = useCallback(async (id: string) => {
    if (workflows.find((workflow) => workflow.id === id)?.readonly) return;

    setDeletingId(id);
    try {
      const res = await fetch(`/api/workflow-library?id=${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setWorkflows((prev) => prev.filter((e) => e.id !== id));
      }
    } catch {
      // Silently fail
    } finally {
      setDeletingId(null);
    }
  }, [workflows]);

  const handleDeleteAllAssets = useCallback(async () => {
    if (assets.length === 0) return;
    if (
      !confirm(
        'Delete all assets and remove their files from the server? This cannot be undone.'
      )
    ) {
      return;
    }
    setBulkDeletingAssets(true);
    try {
      const res = await fetch('/api/asset-library?all=true', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setAssets([]);
      }
    } catch {
      // Silently fail
    } finally {
      setBulkDeletingAssets(false);
    }
  }, [assets.length]);

  const handleDeleteAllWorkflows = useCallback(async () => {
    if (deletableWorkflowCount === 0) return;
    if (!confirm('Delete all saved workflows? This cannot be undone.')) {
      return;
    }
    setBulkDeletingWorkflows(true);
    try {
      const res = await fetch('/api/workflow-library?all=true', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setWorkflows((prev) => prev.filter((workflow) => workflow.readonly));
        window.dispatchEvent(new CustomEvent('workflow-library-changed'));
      }
    } catch {
      // Silently fail
    } finally {
      setBulkDeletingWorkflows(false);
    }
  }, [deletableWorkflowCount]);

  const handleRenameWorkflow = useCallback(async (id: string, newName: string) => {
    if (workflows.find((workflow) => workflow.id === id)?.readonly) {
      setRenamingId(null);
      return;
    }

    if (!newName.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      const res = await fetch('/api/workflow-library', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: newName.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setWorkflows((prev) =>
          prev.map((e) => (e.id === id ? { ...e, name: newName.trim(), updatedAt: data.entry.updatedAt } : e))
        );
      }
    } catch {
      // Silently fail
    } finally {
      setRenamingId(null);
    }
  }, [workflows]);

  const onNodeDragStart = (event: DragEvent<HTMLDivElement>, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onAssetDragStart = (event: DragEvent<HTMLDivElement>, asset: AssetEntry) => {
    event.dataTransfer.setData('application/asset', JSON.stringify({
      id: asset.id,
      assetType: asset.assetType,
      fileUrl: asset.fileUrl,
      fileType: asset.fileType,
      name: asset.name,
    }));
    event.dataTransfer.effectAllowed = 'copy';
  };

  // Group assets by type
  const assetGroups: { type: AssetType; label: string; items: AssetEntry[] }[] = ([
    { type: 'video', label: 'Videos', items: assets.filter((a) => a.assetType === 'video') },
    { type: 'pointcloud', label: 'Point Clouds', items: assets.filter((a) => a.assetType === 'pointcloud') },
    { type: 'splat', label: 'Splats', items: assets.filter((a) => a.assetType === 'splat') },
    { type: 'model', label: '3D Models', items: assets.filter((a) => a.assetType === 'model') },
    { type: 'render-video', label: 'Render Videos', items: assets.filter((a) => a.assetType === 'render-video') },
  ] as const).map((g) => ({ type: g.type as AssetType, label: g.label, items: g.items })).filter((g) => g.items.length > 0);

  return (
    <>
      {/* Toggle button — fixed position so it never jumps */}
      <button
        onClick={onToggle}
        className="absolute left-3 top-3 z-30 flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
        title={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>

      {collapsed ? (
        <div className="absolute left-0 top-0 z-20 flex h-full w-14 flex-col items-center border-r border-zinc-800 bg-zinc-900/95 pt-14 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={() => {
                onToggle();
                setActiveTab('nodes');
              }}
              className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-zinc-800 hover:text-white ${activeTab === 'nodes' ? 'text-white bg-zinc-800' : 'text-zinc-400'}`}
              title="Nodes"
            >
              <Box size={16} />
            </button>
            <button
              onClick={() => {
                onToggle();
                setActiveTab('assets');
              }}
              className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-zinc-800 hover:text-white ${activeTab === 'assets' ? 'text-white bg-zinc-800' : 'text-zinc-400'}`}
              title="Assets"
            >
              <FolderOpen size={16} />
            </button>
            <button
              onClick={() => {
                onToggle();
                setActiveTab('workflows');
              }}
              className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-zinc-800 hover:text-white ${activeTab === 'workflows' ? 'text-white bg-zinc-800' : 'text-zinc-400'}`}
              title="Workflows"
            >
              <GitBranch size={16} />
            </button>
          </div>
        </div>
      ) : (
        <div className="absolute left-0 top-0 z-20 flex h-full w-[276px] flex-col border-r border-zinc-800 bg-zinc-900/95 pt-14 backdrop-blur-sm">
          {/* Tab switcher: Nodes / Assets / Workflows */}
          <div className="flex border-b border-zinc-800">
            <button
              onClick={() => setActiveTab('nodes')}
              className={`flex flex-1 items-center justify-center gap-1 px-1 py-2 text-[13px] font-semibold transition-colors ${
                activeTab === 'nodes'
                  ? 'text-zinc-100 border-b-2 border-zinc-300 bg-zinc-800/40'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/20'
              }`}
            >
              <Box size={14} />
              Nodes
            </button>
            <button
              onClick={() => setActiveTab('assets')}
              className={`flex flex-1 items-center justify-center gap-1 px-1 py-2 text-[13px] font-semibold transition-colors ${
                activeTab === 'assets'
                  ? 'text-zinc-100 border-b-2 border-zinc-300 bg-zinc-800/40'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/20'
              }`}
            >
              <FolderOpen size={14} />
              Assets
            </button>
            <button
              onClick={() => setActiveTab('workflows')}
              className={`flex flex-1 items-center justify-center gap-1 px-1 py-2 text-[13px] font-semibold transition-colors ${
                activeTab === 'workflows'
                  ? 'text-zinc-100 border-b-2 border-zinc-300 bg-zinc-800/40'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/20'
              }`}
            >
              <GitBranch size={14} />
              Workflows
            </button>
          </div>

          {/* Navigation + bottom bar (assets / workflows) */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
            {/* === Nodes Tab === */}
            {activeTab === 'nodes' && (
              <div className="px-2 py-2 space-y-1">
                {NODE_TYPE_CONFIGS.map((config) => {
                  const theme = getNodeVisualTheme(config.type);

                  return (
                    <div
                      key={config.type}
                      draggable
                      onDragStart={(e) => onNodeDragStart(e, config.type)}
                      className="flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 active:cursor-grabbing"
                    >
                      <span
                        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border"
                        style={{
                          backgroundColor: theme.accentSoft,
                          borderColor: theme.accentMuted,
                          color: theme.text,
                        }}
                      >
                        {NODE_ICONS[config.type]}
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-semibold text-zinc-200">{config.label}</span>
                        <NodeTypeDescription description={config.description} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* === Assets Tab === */}
            {activeTab === 'assets' && (
              <div className="px-2 py-2 space-y-0.5">
                {/* Hint */}
                <p className="px-1 py-1 text-[10px] text-zinc-400 leading-tight">
                  Drag assets onto canvas nodes to fill in
                </p>

                {/* Empty state */}
                {assets.length === 0 && !assetsLoading && (
                  <div className="px-2 py-3 text-center text-[11px] text-zinc-400">
                    No assets yet
                  </div>
                )}

                {/* Asset groups by type */}
                {assetGroups.map((group, groupIdx) => (
                  <div key={group.type}>
                    {groupIdx > 0 && <div className="my-1.5 border-t border-zinc-700/60" />}

                    <button
                      type="button"
                      onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.type]: !prev[group.type] }))}
                      className="flex w-full items-center gap-1.5 rounded-md px-1 pt-1.5 pb-0.5 text-left transition-colors hover:bg-zinc-800/60"
                    >
                      {collapsedGroups[group.type] ? (
                        <ChevronRight size={12} className="shrink-0 text-zinc-400" />
                      ) : (
                        <ChevronDown size={12} className="shrink-0 text-zinc-400" />
                      )}
                      <span className="shrink-0 text-zinc-400">{ASSET_TYPE_ICONS[group.type]}</span>
                      <span className="text-[13px] font-bold text-zinc-300">{group.label}</span>
                      <span className="text-[13px] text-zinc-500">({group.items.length})</span>
                    </button>

                    {!collapsedGroups[group.type] &&
                      group.items.map((item) => (
                        <div
                          key={item.id}
                          draggable={item.assetType !== 'render-video'}
                          onDragStart={(e) => onAssetDragStart(e, item)}
                          className={`group flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-zinc-800 ${
                            item.assetType !== 'render-video' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
                          }`}
                          title={item.assetType !== 'render-video' ? 'Drag onto canvas node to fill in' : undefined}
                        >
                          <AssetVisual item={item} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-1">
                              <span className="truncate text-[13px] font-medium text-zinc-400">{item.name}</span>
                              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                <button
                                  type="button"
                                  onClick={() => handleCopyUrl(item.id, item.fileUrl)}
                                  disabled={bulkDeletingAssets}
                                  className="flex h-[18px] w-[18px] items-center justify-center rounded text-zinc-600 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-50"
                                  title="Copy URL"
                                >
                                  <Copy size={11} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteAsset(item.id)}
                                  disabled={deletingId === item.id || bulkDeletingAssets}
                                  className="flex h-[18px] w-[18px] items-center justify-center rounded text-zinc-600 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-50"
                                  title="Delete"
                                >
                                  <Trash2 size={11} />
                                </button>
                              </div>
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                              <span className="text-zinc-400">{formatDate(item.createdAt)}</span>
                              <span className="rounded bg-zinc-800 px-1 uppercase text-[10px] text-zinc-500">
                                {item.fileType}
                              </span>
                            </div>
                            {copiedId === item.id && (
                              <span className="text-[10px] text-[#5a8a6a]">URL copied</span>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            )}

            {/* === Workflows Tab === */}
            {activeTab === 'workflows' && (
              <div className="px-2 py-2 space-y-0.5">
                {/* Hint */}
                <p className="px-1 py-1 text-[10px] text-zinc-400 leading-tight">
                  Click a workflow to load it. Default Workflow is a built-in preset and cannot be deleted.
                </p>

                {/* Empty state */}
                {workflows.length === 0 && !workflowsLoading && (
                  <div className="px-2 py-3 text-center text-[11px] text-zinc-400">
                    No saved workflows
                  </div>
                )}

                {/* Workflow list */}
                {workflows.map((wf) => {
                  const isReadonlyWorkflow = wf.readonly === true;

                  return (
                    <div
                      key={wf.id}
                      className="group flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[13px] transition-colors hover:bg-zinc-800"
                    >
                      <span className="shrink-0 text-zinc-500"><GitBranch size={17} /></span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          {renamingId === wf.id && !isReadonlyWorkflow ? (
                            <div className="flex items-center gap-1 flex-1">
                              <input
                                type="text"
                                value={renamingValue}
                                onChange={(e) => setRenamingValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleRenameWorkflow(wf.id, renamingValue);
                                  if (e.key === 'Escape') setRenamingId(null);
                                }}
                                className="flex-1 bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-[13px] text-zinc-200 outline-none focus:border-zinc-400"
                                autoFocus
                              />
                              <button
                                type="button"
                                onClick={() => handleRenameWorkflow(wf.id, renamingValue)}
                                disabled={bulkDeletingWorkflows}
                                className="flex h-[18px] w-[18px] items-center justify-center rounded text-[#5a8a6a] hover:bg-zinc-700 disabled:opacity-50"
                                title="Confirm"
                              >
                                <Check size={13} />
                              </button>
                            </div>
                          ) : (
                            <>
                              <span
                                className="truncate text-[13px] font-medium text-zinc-100 cursor-pointer hover:text-white"
                                onClick={() => onLoadWorkflow(wf)}
                                title="Click to load this workflow"
                              >
                                {wf.name}
                              </span>
                              {isReadonlyWorkflow ? (
                                <span className="shrink-0 rounded border border-amber-700/40 bg-amber-900/25 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-200/80">
                                  Preset
                                </span>
                              ) : (
                                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setRenamingId(wf.id);
                                      setRenamingValue(wf.name);
                                    }}
                                    disabled={bulkDeletingWorkflows}
                                    className="flex h-[18px] w-[18px] items-center justify-center rounded text-zinc-600 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-50"
                                    title="Rename"
                                  >
                                    <Pencil size={11} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteWorkflow(wf.id)}
                                    disabled={deletingId === wf.id || bulkDeletingWorkflows}
                                    className="flex h-[18px] w-[18px] items-center justify-center rounded text-zinc-600 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-50"
                                    title="Delete"
                                  >
                                    <Trash2 size={11} />
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                          <span className="text-zinc-400">
                            {isReadonlyWorkflow ? 'Built-in' : formatDate(wf.updatedAt)}
                          </span>
                          <span className="rounded bg-zinc-800 px-1 text-zinc-500">
                            {(wf.nodes as unknown[]).length} nodes
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            </div>

            {(activeTab === 'assets' || activeTab === 'workflows') && (
              <div className="flex shrink-0 justify-end gap-1.5 border-t border-zinc-800 bg-zinc-900/98 px-2 py-2 backdrop-blur-sm">
                {activeTab === 'assets' ? (
                  <>
                    <button
                      type="button"
                      onClick={fetchAssets}
                      disabled={assetsLoading || bulkDeletingAssets}
                      title="Refresh assets"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700/90 bg-zinc-800/90 text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <RefreshCw size={13} className={assetsLoading ? 'animate-spin' : undefined} />
                    </button>
                    <button
                      type="button"
                      onClick={handleDeleteAllAssets}
                      disabled={assetsLoading || bulkDeletingAssets || assets.length === 0}
                      title="Delete all assets and their files"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-red-900/45 bg-zinc-800/90 text-red-400/95 transition-colors hover:border-red-800/60 hover:bg-red-950/35 hover:text-red-300 disabled:pointer-events-none disabled:opacity-35"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={fetchWorkflows}
                      disabled={workflowsLoading || bulkDeletingWorkflows}
                      title="Refresh workflows"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700/90 bg-zinc-800/90 text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <RefreshCw size={13} className={workflowsLoading ? 'animate-spin' : undefined} />
                    </button>
                    <button
                      type="button"
                      onClick={handleDeleteAllWorkflows}
                      disabled={workflowsLoading || bulkDeletingWorkflows || deletableWorkflowCount === 0}
                      title="Delete all saved workflows"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-red-900/45 bg-zinc-800/90 text-red-400/95 transition-colors hover:border-red-800/60 hover:bg-red-950/35 hover:text-red-300 disabled:pointer-events-none disabled:opacity-35"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
