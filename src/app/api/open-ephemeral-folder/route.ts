import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { stat } from 'fs/promises';
import {
  getEphemeralSessionFromRequest,
} from '@/lib/ephemeral-storage';
import {
  getOpenFolderCommand,
  isOpenableEphemeralFolderType,
  resolveOpenableEphemeralFolderPath,
} from '@/lib/open-ephemeral-folder';

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const folderType = body && typeof body === 'object' ? (body as { folderType?: unknown }).folderType : null;
    const folderId = body && typeof body === 'object' ? (body as { folderId?: unknown }).folderId : null;

    if (!isOpenableEphemeralFolderType(folderType) || typeof folderId !== 'string') {
      return NextResponse.json({ error: 'Invalid folder request' }, { status: 400 });
    }

    let folderPath: string;
    try {
      folderPath = resolveOpenableEphemeralFolderPath({ sessionId, folderType, folderId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid folder request';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const folderStat = await stat(folderPath).catch(() => null);
    if (!folderStat?.isDirectory()) {
      return NextResponse.json({ error: 'Frames folder not found' }, { status: 404 });
    }

    const { command, args } = getOpenFolderCommand(process.platform, folderPath);
    await execFileAsync(command, args, { timeout: 10000 });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to open folder';
    console.error('[open-ephemeral-folder] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
