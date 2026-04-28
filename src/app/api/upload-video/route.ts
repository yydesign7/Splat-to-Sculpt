import { NextRequest, NextResponse } from 'next/server';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const videoFile = formData.get('video') as File | null;

    if (!videoFile) {
      return NextResponse.json({ error: 'No video file provided' }, { status: 400 });
    }

    const jobId = randomUUID();
    const ext = path.extname(videoFile.name) || '.mp4';
    const publicDir = path.join(process.cwd(), 'public', 'videos', jobId);
    await mkdir(publicDir, { recursive: true });

    const videoPath = path.join(publicDir, `input${ext}`);
    const videoBuffer = Buffer.from(await videoFile.arrayBuffer());
    await writeFile(videoPath, videoBuffer);

    const serverPath = `/videos/${jobId}/input${ext}`;

    return NextResponse.json({
      success: true,
      videoServerPath: serverPath,
      videoName: videoFile.name,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Video upload failed';
    console.error('[upload-video] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
