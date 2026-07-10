// File-system based task status store for Gaussian splat generation.
// Uses /tmp/gaussian-tasks/ to persist across Next.js server isolates.

import { mkdir, readFile, writeFile, unlink, readdir } from 'fs/promises';
import path from 'path';

export interface GaussianTask {
  status: 'processing' | 'done' | 'error' | 'cancelled';
  progress: string;
  progressStep?: number;
  deviceType?: 'cuda' | 'mps' | 'cpu';
  computeBackend?: string;
  trainingMode?: 'auto' | 'train';
  targetPlyType?: string;
  trueTrainingAvailable?: boolean;
  trueTrainingUnavailableReason?: string;
  ephemeralSessionId?: string;
  trainingPid?: number;
  currentTrainingIteration?: number;
  maxTrainingIterations?: number;
  pointcloudTaskId?: string;
  result?: {
    splatUrl: string;
    sourcePlyUrl: string;
    gaussianCount: number;
    format: '3dgs-ply';
    layerFiles?: string[];
    layerNames?: string[];
    computeBackend?: string;
  };
  error?: string;
}

const TASK_DIR = '/tmp/gaussian-tasks';

function taskPath(taskId: string): string {
  return path.join(TASK_DIR, `${taskId}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(TASK_DIR, { recursive: true });
}

export async function getTask(taskId: string): Promise<GaussianTask | undefined> {
  try {
    const raw = await readFile(taskPath(taskId), 'utf-8');
    return JSON.parse(raw) as GaussianTask;
  } catch {
    return undefined;
  }
}

export async function setTask(taskId: string, update: Partial<GaussianTask>): Promise<void> {
  await ensureDir();
  const existing = await getTask(taskId);
  const merged: GaussianTask = {
    status: 'processing',
    progress: '',
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

export async function listTasks(): Promise<Array<{ taskId: string; task: GaussianTask }>> {
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
  return tasks.filter((item): item is { taskId: string; task: GaussianTask } => item !== null);
}
