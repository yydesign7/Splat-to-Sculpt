import { NextRequest, NextResponse } from 'next/server';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  buildEphemeralFileUrl,
  ensureSessionRoot,
  getEphemeralSessionFromRequest,
} from '@/lib/ephemeral-storage';

/**
 * POST /api/upload-model
 *
 * Upload a model file (OBJ/GLB/FBX/PLY) or texture image under the workflow ephemeral session.
 */
export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fileType = (formData.get('type') as string) || 'model';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const jobId = randomUUID();
    const ext = path.extname(file.name) || '';
    const baseName = path.basename(file.name, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeName = `${baseName}${ext}`;

    const subDir =
      fileType === 'texture'
        ? 'textures'
        : fileType === 'pointcloud/splat-source'
          ? 'splat-sources'
          : fileType === 'pointcloud'
            ? 'pointclouds'
            : 'uploads';
    const sessionRoot = await ensureSessionRoot(sessionId);
    const destDir = path.join(sessionRoot, subDir, jobId);
    await mkdir(destDir, { recursive: true });

    const filePath = path.join(destDir, safeName);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    const rel = `${subDir}/${jobId}/${safeName}`;
    const publicUrl = buildEphemeralFileUrl(sessionId, rel);

    const companionUrls: string[] = [];
    const companionEntries = formData.getAll('companions') as File[];
    for (const companion of companionEntries) {
      if (!companion || !companion.name) continue;
      const compExt = path.extname(companion.name) || '';
      const compBase = path.basename(companion.name, compExt).replace(/[^a-zA-Z0-9_-]/g, '_');
      const compSafeName = `${compBase}${compExt}`;
      const compPath = path.join(destDir, compSafeName);
      const compBuffer = Buffer.from(await companion.arrayBuffer());
      await writeFile(compPath, compBuffer);
      companionUrls.push(buildEphemeralFileUrl(sessionId, `${subDir}/${jobId}/${compSafeName}`));
    }

    return NextResponse.json({
      success: true,
      url: publicUrl,
      fileName: file.name,
      companionUrls,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'File upload failed';
    console.error('[upload-model] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
