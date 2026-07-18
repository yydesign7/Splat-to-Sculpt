// File-system based task status store for mesh generation
// Uses /tmp/mesh-tasks/ to persist across Next.js serverless isolates

import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import path from 'path';

export interface MeshTask {
  status: 'processing' | 'done' | 'error';
  progress: string;
  /** Browser session id for writing mesh under .data/ephemeral/<id>/ */
  ephemeralSessionId?: string;
  result?: {
    meshUrl: string;
    meshFormat: string;
    faceCount: number;
    vertexCount: number;
    reconstructionProfile?: string;
    requestedReconstructionProfile?: string;
  };
  error?: string;
}

const TASK_DIR = '/tmp/mesh-tasks';

function taskPath(taskId: string): string {
  return path.join(TASK_DIR, `${taskId}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(TASK_DIR, { recursive: true });
}

export async function getTask(taskId: string): Promise<MeshTask | undefined> {
  try {
    const raw = await readFile(taskPath(taskId), 'utf-8');
    return JSON.parse(raw) as MeshTask;
  } catch {
    return undefined;
  }
}

export async function setTask(taskId: string, update: Partial<MeshTask>): Promise<void> {
  await ensureDir();
  const existing = await getTask(taskId);
  const merged: MeshTask = {
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
