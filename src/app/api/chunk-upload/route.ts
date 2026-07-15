import { NextRequest, NextResponse } from 'next/server';
import { mkdir, writeFile, appendFile, readFile, rm, stat } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  buildEphemeralFileUrl,
  getEphemeralSessionFromRequest,
  getSessionRoot,
} from '@/lib/ephemeral-storage';

// In-memory map to track upload sessions
const uploadSessions = new Map<string, {
  chunksDir: string;
  totalChunks: number;
  receivedChunks: Set<number>;
  fileName: string;
  contentType: string;
  createdAt: number;
}>();

// Clean up old sessions periodically (older than 1 hour)
function cleanupOldSessions() {
  const now = Date.now();
  for (const [sessionId, session] of uploadSessions.entries()) {
    if (now - session.createdAt > 3600000) {
      uploadSessions.delete(sessionId);
      rm(session.chunksDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * POST /api/chunk-upload
 * 
 * Three operations:
 * 1. "init" - Initialize a new upload session, returns sessionId
 * 2. "upload" - Upload a chunk (multipart/form-data)
 * 3. "complete" - Assemble all chunks into the final file
 */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';

    // Operation 1: Initialize upload session
    if (contentType.includes('application/json')) {
      const body = await request.json();
      const { action } = body;

      if (action === 'init') {
        const { fileName, totalChunks, contentType: fileContentType } = body;
        if (!fileName || !totalChunks) {
          return NextResponse.json({ error: 'Missing initialization parameters' }, { status: 400 });
        }

        const sessionId = randomUUID();
        const chunksDir = path.join('/tmp', `chunk-uploads`, sessionId);
        await mkdir(chunksDir, { recursive: true });

        uploadSessions.set(sessionId, {
          chunksDir,
          totalChunks,
          receivedChunks: new Set(),
          fileName,
          contentType: fileContentType || 'video/mp4',
          createdAt: Date.now(),
        });

        // Clean up old sessions
        cleanupOldSessions();

        return NextResponse.json({ success: true, sessionId });
      }

      if (action === 'complete') {
        const { sessionId: chunkSessionId } = body as { sessionId?: string };
        if (!chunkSessionId) {
          return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
        }

        const workflowSessionId = getEphemeralSessionFromRequest(request);
        if (!workflowSessionId) {
          return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
        }

        const session = uploadSessions.get(chunkSessionId);
        if (!session) {
          return NextResponse.json({ error: 'Upload session not found or expired' }, { status: 400 });
        }

        if (session.receivedChunks.size !== session.totalChunks) {
          return NextResponse.json({
            error: `Chunk incomplete: received ${session.receivedChunks.size}/${session.totalChunks}`,
            receivedChunks: session.receivedChunks.size,
            totalChunks: session.totalChunks,
          }, { status: 400 });
        }

        const ext = session.fileName.split('.').pop()?.toLowerCase() || 'mp4';
        const jobId = randomUUID();
        const videoDir = path.join(getSessionRoot(workflowSessionId), 'videos', jobId);
        await mkdir(videoDir, { recursive: true });
        const finalPath = path.join(videoDir, `input.${ext}`);

        for (let i = 0; i < session.totalChunks; i++) {
          const chunkPath = path.join(session.chunksDir, `chunk_${i}`);
          const chunkData = await readFile(chunkPath);
          await appendFile(finalPath, chunkData);
        }

        await rm(session.chunksDir, { recursive: true, force: true });
        uploadSessions.delete(chunkSessionId);

        const fileStat = await stat(finalPath);
        const videoServerPath = buildEphemeralFileUrl(workflowSessionId, `videos/${jobId}/input.${ext}`);

        return NextResponse.json({
          success: true,
          videoServerPath,
          videoName: session.fileName,
          fileSize: fileStat.size,
        });
      }

      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    // Operation 2: Upload a chunk (multipart/form-data)
    const formData = await request.formData();
    const sessionId = formData.get('sessionId') as string | null;
    const chunkIndex = formData.get('chunkIndex') as string | null;
    const chunkFile = formData.get('chunk') as File | null;

    if (!sessionId || chunkIndex === null || !chunkFile) {
      return NextResponse.json({ error: 'Missing chunk upload parameters' }, { status: 400 });
    }

    const session = uploadSessions.get(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Upload session not found or expired' }, { status: 400 });
    }

    const idx = parseInt(chunkIndex, 10);
    const chunkPath = path.join(session.chunksDir, `chunk_${idx}`);
    const chunkBuffer = Buffer.from(await chunkFile.arrayBuffer());
    await writeFile(chunkPath, chunkBuffer);

    session.receivedChunks.add(idx);

    return NextResponse.json({
      success: true,
      receivedChunks: session.receivedChunks.size,
      totalChunks: session.totalChunks,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Chunk upload failed';
    console.error('[chunk-upload] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
