'use client';

import { Play, Square, RotateCcw, Maximize, Save } from 'lucide-react';

interface TopBarProps {
  onRun: () => void;
  onStop: () => void;
  onReset: () => void;
  onFitView: () => void;
  onSaveWorkflow: () => void;
  workflowRunning: boolean;
  progress: { done: number; total: number };
}

export default function TopBar({ onRun, onStop, onReset, onFitView, onSaveWorkflow, workflowRunning, progress }: TopBarProps) {
  return (
    <div className="flex h-[54px] items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4">
      {/* Left: Brand */}
      <div className="flex items-end gap-3">
        <span className="text-[18px] font-bold leading-none text-white">Splat to Sculpt</span>
        <span className="text-[12px] leading-none text-zinc-500">Node-based 3D Gaussian Model Generator</span>
      </div>

      {/* Right: Controls */}
      <div className="flex items-center gap-1">
        {/* Progress indicator when running */}
        {workflowRunning && (
          <span className="mr-2 text-[12px] text-zinc-400">
            {progress.done}/{progress.total} completed
          </span>
        )}
        <button
          onClick={onSaveWorkflow}
          className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[14px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
          title="Save Workflow"
        >
          <Save size={15} />
          Save
        </button>
        <button
          onClick={onReset}
          className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[14px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
          title="Reset Canvas"
        >
          <RotateCcw size={15} />
          Reset
        </button>
        <button
          onClick={onFitView}
          className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[14px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
          title="Fit View"
        >
          <Maximize size={15} />
          Fit
        </button>
        {workflowRunning ? (
          <button
            onClick={onStop}
            className="flex h-8 items-center gap-1.5 rounded-md bg-gradient-to-r from-[#7a4a4a] to-[#6a4a4a] px-3 text-[14px] font-medium text-zinc-200 transition-opacity hover:opacity-90"
            title="Stop Workflow"
          >
            <Square size={14} />
            Stop
          </button>
        ) : (
          <button
            onClick={onRun}
            className="flex h-8 items-center gap-1.5 rounded-md bg-gradient-to-r from-[#6a4a55] to-[#5a5a7a] px-3 text-[14px] font-medium text-zinc-200 transition-opacity hover:opacity-90"
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
