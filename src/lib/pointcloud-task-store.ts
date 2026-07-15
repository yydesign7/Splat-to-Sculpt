// File-system based task status store for pointcloud generation
// Uses /tmp/pointcloud-tasks/ to persist across Next.js serverless isolates

import { mkdir, readFile, writeFile, unlink, readdir } from 'fs/promises';
import path from 'path';

export interface PointCloudTask {
  status: 'processing' | 'done' | 'error' | 'cancelled';
  progress: string;
  progressStep: number; // 1-11: Prepare / Feature Extraction / Feature Matching / Sparse Reconstruction / Image Undistortion / Dense Matching / Dense Fusion / Segmentation / Depth Estimation / Depth Alignment & Fusion / Generate PLY
  activePid?: number;
  enableDepthFusion?: boolean;
  enableSegmentation?: boolean;
  enableForegroundMask?: boolean;
  /** Browser session id for publishing PLY under .data/ephemeral/<id>/ */
  ephemeralSessionId?: string;
  result?: {
    plyUrl: string;
    pointCount: number;
    layerFiles?: string[];
    layerNames?: string[];
    colmapWorkspacePath?: string;
    colmapImagesDir?: string;
    colmapSparseDir?: string;
    colmapDatabasePath?: string;
    colmapMasksDir?: string;
  };
  error?: string;
}

const TASK_DIR = '/tmp/pointcloud-tasks';

function taskPath(taskId: string): string {
  return path.join(TASK_DIR, `${taskId}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(TASK_DIR, { recursive: true });
}

export async function getTask(taskId: string): Promise<PointCloudTask | undefined> {
  try {
    const raw = await readFile(taskPath(taskId), 'utf-8');
    return JSON.parse(raw) as PointCloudTask;
  } catch {
    return undefined;
  }
}

export async function setTask(taskId: string, update: Partial<PointCloudTask>): Promise<void> {
  await ensureDir();
  const existing = await getTask(taskId);
  const merged: PointCloudTask = {
    status: 'processing',
    progress: '',
    progressStep: 0,
    ...(existing || {}),
    ...update,
  };
  await writeFile(taskPath(taskId), JSON.stringify(merged), 'utf-8');
}

export async function deleteTask(taskId: string): Promise<void> {
  try {
    await unlink(taskPath(taskId));
  } catch {
    // ignore if file doesn't exist
  }
}

export async function listTasks(): Promise<Array<{ taskId: string; task: PointCloudTask }>> {
  await ensureDir();
  const entries = await readdir(TASK_DIR).catch(() => [] as string[]);
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.json'))
      .map(async (entry) => {
        const taskId = entry.replace(/\.json$/, '');
        const task = await getTask(taskId);
        return task ? { taskId, task } : null;
      }),
  );
  return tasks.filter((item): item is { taskId: string; task: PointCloudTask } => item !== null);
}
