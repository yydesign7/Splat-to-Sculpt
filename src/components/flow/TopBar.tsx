'use client';

import { Eraser, Play, Square, Save } from 'lucide-react';

interface TopBarProps {
  onRun: () => void;
  onStop: () => void;
  onClear: () => void;
  onSaveWorkflow: () => void;
  workflowRunning: boolean;
  progress: { done: number; total: number };
}

export default function TopBar({
  onRun,
  onStop,
  onClear,
  onSaveWorkflow,
  workflowRunning,
  progress,
}: TopBarProps) {
  return (
    <div className="flex h-[54px] items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4">
      {/* Left: Brand */}
      <div className="flex items-end gap-3">
        <span className="text-lg font-bold leading-none text-white">Splat to Sculpt</span>
        <span className="text-[11px] font-medium leading-none text-zinc-400">
          Node-based 3D Gaussian Model Generator
        </span>
      </div>

      {/* Right: Controls */}
      <div className="flex items-center gap-1">
        {workflowRunning && (
          <span className="mr-2 text-[11px] font-medium text-zinc-300">
            {progress.done}/{progress.total} completed
          </span>
        )}
        <button
          onClick={onSaveWorkflow}
          className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
          title="Save current workflow to the workflow library"
        >
          <Save size={15} />
          Save Workflow
        </button>
        <button
          onClick={onClear}
          className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
          title="Clear uploaded files and generated outputs"
        >
          <Eraser size={15} />
          Clear
        </button>
        {workflowRunning ? (
          <button
            onClick={onStop}
            className="flex h-8 items-center gap-1.5 rounded-md border border-red-700/50 bg-red-900/45 px-3 text-[13px] font-semibold text-red-100 transition-colors hover:border-red-600/60 hover:bg-red-900/65"
            title="Stop Workflow"
          >
            <Square size={14} />
            Stop
          </button>
        ) : (
          <button
            onClick={onRun}
            className="flex h-8 items-center gap-1.5 rounded-md border border-emerald-700/50 bg-emerald-900/45 px-3 text-[13px] font-semibold text-emerald-100 transition-colors hover:border-emerald-600/60 hover:bg-emerald-900/65"
            title="Run Workflow"
          >
            <Play size={14} />
            Run
          </button>
        )}
      </div>
    </div>
  );
}
