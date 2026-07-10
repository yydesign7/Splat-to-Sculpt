import { NextRequest, NextResponse } from 'next/server';
import { getEphemeralSessionFromRequest } from '@/lib/ephemeral-storage';
import {
  listTasks as listGaussianTasks,
  setTask as setGaussianTask,
} from '@/lib/gaussian-task-store';
import {
  listTasks as listPointCloudTasks,
  setTask as setPointCloudTask,
} from '@/lib/pointcloud-task-store';
import { killProcessTree } from '@/lib/process-tree';

export async function POST(request: NextRequest) {
  const sessionId = getEphemeralSessionFromRequest(request);
  if (!sessionId) {
    return NextResponse.json({ error: 'Missing or invalid workflow session' }, { status: 400 });
  }

  const [gaussianTasks, pointCloudTasks] = await Promise.all([
    listGaussianTasks(),
    listPointCloudTasks(),
  ]);

  const gaussianPointCloudTaskIds = new Set<string>();
  let cancelledGaussian = 0;
  let cancelledPointCloud = 0;

  for (const { taskId, task } of gaussianTasks) {
    if (task.ephemeralSessionId !== sessionId || task.status !== 'processing') continue;
    if (typeof task.pointcloudTaskId === 'string') {
      gaussianPointCloudTaskIds.add(task.pointcloudTaskId);
    }
    if (typeof task.trainingPid === 'number') {
      await killProcessTree(task.trainingPid);
    }
    await setGaussianTask(taskId, {
      status: 'cancelled',
      progress: 'Stopped',
      trainingPid: undefined,
    });
    cancelledGaussian += 1;
  }

  for (const { taskId, task } of pointCloudTasks) {
    const belongsToSession = task.ephemeralSessionId === sessionId || gaussianPointCloudTaskIds.has(taskId);
    if (!belongsToSession || task.status !== 'processing') continue;
    if (typeof task.activePid === 'number') {
      await killProcessTree(task.activePid);
    }
    await setPointCloudTask(taskId, {
      status: 'cancelled',
      progress: 'Stopped',
      activePid: undefined,
    });
    cancelledPointCloud += 1;
  }

  return NextResponse.json({
    success: true,
    cancelledGaussian,
    cancelledPointCloud,
  });
}
