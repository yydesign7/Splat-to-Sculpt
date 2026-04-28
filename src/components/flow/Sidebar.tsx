'use client';

import { useState, useEffect, useCallback, type DragEvent } from 'react';
import {
  ChevronRight,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Video,
  Film,
  Cloud,
  Palette,
  Box,
  Clock,
  MonitorPlay,
  Layers,
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
} from 'lucide-react';
import { NODE_TYPE_CONFIGS } from '@/lib/node-config';
import { isListedSidebarAsset } from '@/lib/asset-sidebar-policy';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onLoadWorkflow: (entry: { nodes: unknown[]; edges: unknown[] }) => void;
}

interface HistoryEntry {
  id: string;
  name: string;
  modelUrl: string | null;
  modelType: string | null;
  thumbnailUrl: string | null;
  sourceNode: string;
  createdAt: string;
}

export type AssetType = 'video' | 'pointcloud' | 'model' | 'render-video';

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
}

type TabKey = 'nodes' | 'assets' | 'workflows';

const NODE_ICONS: Record<string, React.ReactNode> = {
  videoUpload: <Video size={17} />,
  frameExtraction: <Film size={17} />,
  pointCloud: <Cloud size={17} />,
  material: <Palette size={17} />,
  modelOrganize: <Box size={17} />,
  videoPreview: <MonitorPlay size={17} />,
  modelSurface: <Layers size={17} />,
  modelGeneration: <Box size={17} />,
  stickyNote: <StickyNote size={17} />,
};

/** Map sourceNode to a human-readable label */
const SOURCE_NODE_LABELS: Record<string, string> = {
  modelGeneration: '3DGS Model Gen',
  modelSurface: 'Surface Processing',
  modelOrganize: 'Model Cleanup',
  videoUpload: 'Video Upload',
  pointCloud: 'Point Cloud Gen',
  videoPreview: 'Video Preview',
};

/** Map assetType to icon */
const ASSET_TYPE_ICONS: Record<AssetType, React.ReactNode> = {
  video: <FileVideo size={17} />,
  pointcloud: <FileArchive size={17} />,
  model: <FileBox size={17} />,
  'render-video': <FileVideo size={17} />,
};

/** Map assetType to dot color */
const ASSET_TYPE_COLORS: Record<AssetType, string> = {
  video: '#4a6a8a',
  pointcloud: '#4a7a74',
  model: '#7a4a55',
  'render-video': '#5a7a6a',
};

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowEntry[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [bulkDeletingAssets, setBulkDeletingAssets] = useState(false);
  const [bulkDeletingWorkflows, setBulkDeletingWorkflows] = useState(false);
  const [bulkDeletingHistory, setBulkDeletingHistory] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/model-history');
      const data = await res.json();
      if (data.success) {
        setHistory(data.entries);
      }
    } catch {
      // Silently fail
    } finally {
      setHistoryLoading(false);
    }
  }, []);

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

  // Fetch history when the history section is opened
  useEffect(() => {
    if (historyOpen) {
      fetchHistory();
    }
  }, [historyOpen, fetchHistory]);

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
      if (historyOpen) fetchHistory();
      if (activeTab === 'assets') fetchAssets();
      if (activeTab === 'workflows') fetchWorkflows();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [historyOpen, activeTab, fetchHistory, fetchAssets, fetchWorkflows]);

  // Refresh workflows when a new workflow is saved
  useEffect(() => {
    const onWorkflowSaved = () => {
      fetchWorkflows();
    };
    window.addEventListener('workflow-library-changed', onWorkflowSaved);
    return () => window.removeEventListener('workflow-library-changed', onWorkflowSaved);
  }, [fetchWorkflows]);

  const handleDeleteHistory = useCallback(async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/model-history?id=${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setHistory((prev) => prev.filter((e) => e.id !== id));
      }
    } catch {
      // Silently fail
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleDeleteAllHistory = useCallback(async () => {
    if (history.length === 0) return;
    if (
      !confirm(
        'Delete all model generation history records? This cannot be undone.'
      )
    ) {
      return;
    }
    setBulkDeletingHistory(true);
    try {
      const res = await fetch('/api/model-history?all=true', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setHistory([]);
      }
    } catch {
      // Silently fail
    } finally {
      setBulkDeletingHistory(false);
    }
  }, [history.length]);

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
  }, []);

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
    if (workflows.length === 0) return;
    if (!confirm('Delete all saved workflows? This cannot be undone.')) {
      return;
    }
    setBulkDeletingWorkflows(true);
    try {
      const res = await fetch('/api/workflow-library?all=true', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setWorkflows([]);
        window.dispatchEvent(new CustomEvent('workflow-library-changed'));
      }
    } catch {
      // Silently fail
    } finally {
      setBulkDeletingWorkflows(false);
    }
  }, [workflows.length]);

  const handleRenameWorkflow = useCallback(async (id: string, newName: string) => {
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
  }, []);

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
            <button
              onClick={() => {
                onToggle();
                setHistoryOpen(true);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
              title="Model History"
            >
              <Clock size={16} />
            </button>
          </div>
        </div>
      ) : (
        <div className="absolute left-0 top-0 z-20 flex h-full w-[276px] flex-col border-r border-zinc-800 bg-zinc-900/95 pt-14 backdrop-blur-sm">
{/* Tab switcher: Nodes / Assets / Workflows */}
          <div className="flex border-b border-zinc-800">
            <button
              onClick={() => setActiveTab('nodes')}
              className={`flex flex-1 items-center justify-center gap-1 px-1 py-2 text-[14px] font-medium transition-colors ${
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
              className={`flex flex-1 items-center justify-center gap-1 px-1 py-2 text-[14px] font-medium transition-colors ${
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
              className={`flex flex-1 items-center justify-center gap-1 px-1 py-2 text-[14px] font-medium transition-colors ${
                activeTab === 'workflows'
                  ? 'text-zinc-100 border-b-2 border-zinc-300 bg-zinc-800/40'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/20'
              }`}
            >
              <GitBranch size={14} />
              Workflows
            </button>
          </div>

          {/* Navigation */}
          <div className="flex-1 overflow-y-auto">
            {/* === Nodes Tab === */}
            {activeTab === 'nodes' && (
              <div className="px-2 py-2 space-y-1">
                {NODE_TYPE_CONFIGS.map((config) => (
                  <div
                    key={config.type}
                    draggable
                    onDragStart={(e) => onNodeDragStart(e, config.type)}
                    className="flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-[15px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 active:cursor-grabbing"
                  >
                    <span
                      className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded text-white"
                      style={{ backgroundColor: config.color }}
                    >
                      {NODE_ICONS[config.type]}
                    </span>
                    <div className="flex flex-col">
                      <span className="font-medium">{config.label}</span>
                      <span className="text-[12px] text-zinc-500">{config.description}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* === Assets Tab === */}
            {activeTab === 'assets' && (
              <div className="px-2 py-2 space-y-0.5">
                {/* Refresh + Delete all */}
                <div className="flex w-full justify-center">
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={fetchAssets}
                      disabled={assetsLoading || bulkDeletingAssets}
                      className="flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
                    >
                      <RefreshCw size={10} className={assetsLoading ? 'animate-spin shrink-0' : 'shrink-0'} />
                      Refresh
                    </button>
                    <button
                      type="button"
                      onClick={handleDeleteAllAssets}
                      disabled={assetsLoading || bulkDeletingAssets || assets.length === 0}
                      className="flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] text-red-400/90 transition-colors hover:bg-red-950/40 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent"
                      title="Delete all assets and their files"
                    >
                      <Trash2 size={10} className="shrink-0" />
                      Delete
                    </button>
                  </div>
                </div>

                {/* Hint */}
                <p className="px-1 py-1 text-[9px] text-zinc-600 leading-tight">
                  Drag assets onto canvas nodes to fill in
                </p>

                {/* Empty state */}
                {assets.length === 0 && !assetsLoading && (
                  <div className="px-2 py-3 text-center text-[10px] text-zinc-600">
                    No assets yet
                  </div>
                )}

                {/* Asset groups by type */}
                {assetGroups.map((group) => (
                  <div key={group.type}>
                    {/* Group header */}
                    <div className="flex items-center gap-1.5 px-1 pt-1.5 pb-0.5">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: ASSET_TYPE_COLORS[group.type] }}
                      />
                      <span className="text-[14px] font-semibold tracking-wider text-zinc-400">
                        {group.label}
                      </span>
                      <span className="text-[14px] text-zinc-600">({group.items.length})</span>
                    </div>

                    {/* Group items */}
                    {group.items.map((item) => (
                      <div
                        key={item.id}
                        draggable={item.assetType !== 'render-video'}
                        onDragStart={(e) => onAssetDragStart(e, item)}
                        className={`group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[15px] transition-colors hover:bg-zinc-800 ${
                          item.assetType !== 'render-video' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
                        }`}
                        title={item.assetType !== 'render-video' ? 'Drag onto canvas node to fill in' : undefined}
                      >
                        <span className="shrink-0 text-zinc-500">{ASSET_TYPE_ICONS[item.assetType]}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-zinc-300 truncate text-[14px]">{item.name}</span>
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
                            <span className="text-zinc-500">{formatDate(item.createdAt)}</span>
                            <span className="rounded bg-zinc-800 px-1 uppercase text-zinc-600">
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
                {/* Refresh + Delete all */}
                <div className="flex w-full justify-center">
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={fetchWorkflows}
                      disabled={workflowsLoading || bulkDeletingWorkflows}
                      className="flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
                    >
                      <RefreshCw size={10} className={workflowsLoading ? 'animate-spin shrink-0' : 'shrink-0'} />
                      Refresh
                    </button>
                    <button
                      type="button"
                      onClick={handleDeleteAllWorkflows}
                      disabled={workflowsLoading || bulkDeletingWorkflows || workflows.length === 0}
                      className="flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] text-red-400/90 transition-colors hover:bg-red-950/40 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent"
                      title="Delete all saved workflows"
                    >
                      <Trash2 size={10} className="shrink-0" />
                      Delete
                    </button>
                  </div>
                </div>

                {/* Hint */}
                <p className="px-1 py-1 text-[9px] text-zinc-600 leading-tight">
                  Click a workflow to load it. Use the Save button in the top-right to save the current canvas.
                </p>

                {/* Empty state */}
                {workflows.length === 0 && !workflowsLoading && (
                  <div className="px-2 py-3 text-center text-[10px] text-zinc-600">
                    No saved workflows
                  </div>
                )}

                {/* Workflow list */}
                {workflows.map((wf) => (
                  <div
                    key={wf.id}
                    className="group flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[15px] transition-colors hover:bg-zinc-800"
                  >
                    <span className="shrink-0 text-zinc-500"><GitBranch size={17} /></span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        {renamingId === wf.id ? (
                          <div className="flex items-center gap-1 flex-1">
                            <input
                              type="text"
                              value={renamingValue}
                              onChange={(e) => setRenamingValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRenameWorkflow(wf.id, renamingValue);
                                if (e.key === 'Escape') setRenamingId(null);
                              }}
                              className="flex-1 bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-[14px] text-zinc-200 outline-none focus:border-zinc-400"
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
                              className="text-zinc-300 truncate text-[14px] cursor-pointer hover:text-white"
                              onClick={() => onLoadWorkflow(wf)}
                              title="Click to load this workflow"
                            >
                              {wf.name}
                            </span>
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
                          </>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                        <span className="text-zinc-500">{formatDate(wf.updatedAt)}</span>
                        <span className="rounded bg-zinc-800 px-1 text-zinc-600">
                          {(wf.nodes as unknown[]).length} nodes
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Model History Section — always visible */}
            <div className="border-t border-zinc-800">
              <button
                onClick={() => setHistoryOpen(!historyOpen)}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800/50"
              >
                {historyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Clock size={12} />
                Model History
              </button>
              {historyOpen && (
                <div className="space-y-0.5 px-2 pb-2">
                  {/* Refresh + Delete all */}
                  <div className="flex w-full justify-center">
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={fetchHistory}
                        disabled={historyLoading || bulkDeletingHistory}
                        className="flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
                      >
                        <RefreshCw size={10} className={historyLoading ? 'animate-spin shrink-0' : 'shrink-0'} />
                        Refresh
                      </button>
                      <button
                        type="button"
                        onClick={handleDeleteAllHistory}
                        disabled={historyLoading || bulkDeletingHistory || history.length === 0}
                        className="flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] text-red-400/90 transition-colors hover:bg-red-950/40 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent"
                        title="Delete all history records"
                      >
                        <Trash2 size={10} className="shrink-0" />
                        Delete
                      </button>
                    </div>
                  </div>

                  {/* History entries */}
                  {history.length === 0 && !historyLoading && (
                    <div className="px-2 py-3 text-center text-[10px] text-zinc-600">
                      No generation records
                    </div>
                  )}

                  {history.map((item) => (
                    <div
                      key={item.id}
                      className="group flex items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-zinc-800"
                    >
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#5a8a6a]" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-1">
                          <span className="text-zinc-300 truncate">{item.name}</span>
                          <button
                            type="button"
                            onClick={() => handleDeleteHistory(item.id)}
                            disabled={deletingId === item.id || bulkDeletingHistory}
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-600 opacity-0 transition-all hover:bg-zinc-700 hover:text-zinc-300 group-hover:opacity-100 disabled:opacity-50"
                            title="Delete record"
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[10px] text-zinc-500">{formatDate(item.createdAt)}</span>
                          {item.modelType && (
                            <span className="text-[9px] text-zinc-600 bg-zinc-800 px-1 rounded uppercase">
                              {item.modelType}
                            </span>
                          )}
                        </div>
                        <div className="text-[9px] text-zinc-600 mt-0.5">
                          {SOURCE_NODE_LABELS[item.sourceNode] || item.sourceNode}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
