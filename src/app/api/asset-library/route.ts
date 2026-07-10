import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import { publishUrlToPublicIfEphemeral } from '@/lib/publish-ephemeral-to-public';

const ASSETS_FILE = path.join(process.cwd(), 'public', 'asset-library', 'assets.json');

export type AssetType = 'video' | 'pointcloud' | 'splat' | 'model' | 'render-video';

export interface AssetEntry {
  id: string;
  name: string;
  assetType: AssetType;
  fileUrl: string;
  fileType: string;
  thumbnailUrl: string | null;
  sourceNode: string;
  createdAt: string;
}

async function readAssets(): Promise<AssetEntry[]> {
  try {
    const data = await readFile(ASSETS_FILE, 'utf-8');
    return JSON.parse(data) as AssetEntry[];
  } catch {
    return [];
  }
}

async function writeAssets(entries: AssetEntry[]): Promise<void> {
  await mkdir(path.dirname(ASSETS_FILE), { recursive: true });
  await writeFile(ASSETS_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

const publicRoot = () => path.join(process.cwd(), 'public');

async function unlinkAssetFilesOnDisk(entry: AssetEntry): Promise<void> {
  const root = publicRoot();
  for (const url of [entry.fileUrl, entry.thumbnailUrl]) {
    if (!url || typeof url !== 'string') continue;
    const filePath = path.join(root, url.startsWith('/') ? url.slice(1) : url);
    if (!filePath.startsWith(root)) continue;
    try {
      await unlink(filePath);
    } catch {
      // File may already be deleted or not exist — ignore
    }
  }
}

/**
 * GET /api/asset-library
 * Returns all asset entries sorted by createdAt descending (newest first).
 * Optional query param: ?assetType=video|pointcloud|splat|model|render-video
 */
export async function GET(request: NextRequest) {
  try {
    const entries = await readAssets();
    entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const { searchParams } = new URL(request.url);
    const assetType = searchParams.get('assetType') as AssetType | null;
    const filtered = assetType ? entries.filter((e) => e.assetType === assetType) : entries;

    return NextResponse.json({ success: true, entries: filtered });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to read asset library';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/asset-library
 * Adds a new asset entry. If an entry with the same fileUrl already exists, it is updated instead.
 *
 * Body:
 * {
 *   name: string,
 *   assetType: 'video' | 'pointcloud' | 'splat' | 'model' | 'render-video',
 *   fileUrl: string,
 *   fileType: string,
 *   thumbnailUrl?: string | null,
 *   sourceNode: string,
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, assetType, fileUrl, fileType, thumbnailUrl, sourceNode } = body as {
      name?: string;
      assetType?: AssetType;
      fileUrl?: string;
      fileType?: string;
      thumbnailUrl?: string | null;
      sourceNode?: string;
    };

    if (!fileUrl || !assetType || !sourceNode) {
      return NextResponse.json({ error: 'Missing required parameters (fileUrl, assetType, sourceNode)' }, { status: 400 });
    }

    const entries = await readAssets();

    // Deduplicate: update existing entry with same fileUrl, or add new
    const existingIndex = entries.findIndex((e) => e.fileUrl === fileUrl);
    const id = existingIndex >= 0 ? entries[existingIndex].id : `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();

    const publishedFileUrl = await publishUrlToPublicIfEphemeral(fileUrl, id);
    const publishedThumb = await publishUrlToPublicIfEphemeral(thumbnailUrl ?? null, id);

    const entry: AssetEntry = {
      id,
      name: name || `${sourceNode}_${now.toISOString().slice(0, 19).replace(/[T:]/g, '-')}`,
      assetType,
      fileUrl: publishedFileUrl ?? fileUrl,
      fileType:
        fileType ||
        (publishedFileUrl ?? fileUrl).split('?')[0].split('.').pop()?.toLowerCase() ||
        'unknown',
      thumbnailUrl: publishedThumb ?? thumbnailUrl ?? null,
      sourceNode,
      createdAt: existingIndex >= 0 ? entries[existingIndex].createdAt : now.toISOString(),
    };

    if (existingIndex >= 0) {
      entries[existingIndex] = entry;
    } else {
      entries.push(entry);
    }

    await writeAssets(entries);

    return NextResponse.json({ success: true, entry });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to add asset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/asset-library
 * Deletes an asset entry by id (?id=xxx), or all assets and their files (?all=true).
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    if (searchParams.get('all') === 'true') {
      const entries = await readAssets();
      for (const entry of entries) {
        await unlinkAssetFilesOnDisk(entry);
      }
      await writeAssets([]);
      return NextResponse.json({ success: true, deletedCount: entries.length });
    }

    const targetId = searchParams.get('id');

    if (!targetId) {
      return NextResponse.json({ error: 'Missing asset ID or all=true' }, { status: 400 });
    }

    const entries = await readAssets();
    const index = entries.findIndex((e) => e.id === targetId);
    if (index === -1) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }

    const removed = entries[index];
    entries.splice(index, 1);
    await writeAssets(entries);
    await unlinkAssetFilesOnDisk(removed);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete asset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
