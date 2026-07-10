import { NextRequest, NextResponse } from 'next/server';
import { getTask, setTask } from '@/lib/gaussian-task-store';
import { getEphemeralSessionFromRequest } from '@/lib/ephemeral-storage';
import { killProcessTree } from '@/lib/process-tree';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  if (!taskId) {
    return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
  }

  const task = await getTask(taskId);
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const requestSessionId = getEphemeralSessionFromRequest(request);
  if (task.ephemeralSessionId && requestSessionId !== task.ephemeralSessionId) {
    return NextResponse.json({ error: 'Task does not belong to this workflow session' }, { status: 403 });
  }

  if (typeof task.trainingPid === 'number') {
    await killProcessTree(task.trainingPid);
  }
  if (typeof task.pointcloudTaskId === 'string') {
    await fetch(new URL('/api/cancel-pointcloud', request.nextUrl.origin), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ephemeral-Session-Id': requestSessionId || '',
      },
      body: JSON.stringify({ taskId: task.pointcloudTaskId }),
    }).catch(() => {});
  }

  await setTask(taskId, {
    status: 'cancelled',
    progress: 'Stopped',
    trainingPid: undefined,
  });

  return NextResponse.json({ success: true });
}
