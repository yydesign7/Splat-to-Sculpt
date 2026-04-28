import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable } from 'node:stream';
import path from 'path';
import { ephemeralFileAbsPath, isValidEphemeralSessionId } from '@/lib/ephemeral-storage';

const MIME: Record<string, string> = {
  '.ply': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mtl': 'text/plain',
};

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sid = searchParams.get('sid');
    const rel = searchParams.get('rel');
    if (!isValidEphemeralSessionId(sid) || !rel || rel.includes('..')) {
      return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
    }

    const absPath = ephemeralFileAbsPath(sid, rel);
    const st = await stat(absPath);
    if (!st.isFile()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const nodeStream = createReadStream(absPath);
    const webStream = Readable.toWeb(nodeStream);

    return new NextResponse(webStream as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('[ephemeral-file]', e);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
