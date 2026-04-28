import { NextRequest, NextResponse } from 'next/server';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  buildEphemeralFileUrl,
  ensureSessionRoot,
  getEphemeralSessionFromRequest,
} from '@/lib/ephemeral-storage';

export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const formData = await request.formData();
    const plyFile = formData.get('ply') as File | null;

    if (!plyFile) {
      return NextResponse.json({ error: 'No PLY file provided' }, { status: 400 });
    }

    const jobId = randomUUID();
    const sessionRoot = await ensureSessionRoot(sessionId);
    const publicDir = path.join(sessionRoot, 'pointclouds', jobId);
    await mkdir(publicDir, { recursive: true });

    const plyPath = path.join(publicDir, 'output.ply');
    const plyBuffer = Buffer.from(await plyFile.arrayBuffer());
    await writeFile(plyPath, plyBuffer);

    let pointCount = 0;
    try {
      const header = plyBuffer.toString('utf-8', 0, Math.min(plyBuffer.length, 4096));
      const vertexMatch = header.match(/element vertex (\d+)/);
      if (vertexMatch) {
        pointCount = parseInt(vertexMatch[1], 10);
      }
    } catch {
      // Ignore parse errors
    }

    const rel = `pointclouds/${jobId}/output.ply`;
    const plyUrl = buildEphemeralFileUrl(sessionId, rel);

    return NextResponse.json({
      success: true,
      plyUrl,
      pointCount,
      fileName: plyFile.name,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Point cloud file upload failed';
    console.error('[upload-pointcloud] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
