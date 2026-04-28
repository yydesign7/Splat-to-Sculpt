import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const HISTORY_FILE = path.join(process.cwd(), 'public', 'model-history', 'history.json');

export interface HistoryEntry {
  id: string;
  name: string;
  modelUrl: string | null;
  modelType: string | null;
  thumbnailUrl: string | null;
  sourceNode: string;
  createdAt: string;
}

async function readHistory(): Promise<HistoryEntry[]> {
  try {
    const data = await readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(data) as HistoryEntry[];
  } catch {
    return [];
  }
}

async function writeHistory(entries: HistoryEntry[]): Promise<void> {
  await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

/**
 * GET /api/model-history
 * Returns all history entries sorted by createdAt descending (newest first).
 */
export async function GET() {
  try {
    const entries = await readHistory();
    // Sort newest first
    entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return NextResponse.json({ success: true, entries });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to read history';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/model-history
 * Adds a new history entry.
 *
 * Body:
 * {
 *   name: string,
 *   modelUrl?: string | null,
 *   modelType?: string | null,
 *   thumbnailUrl?: string | null,
 *   sourceNode: string,   // e.g. "modelGeneration", "modelSurface"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, modelUrl, modelType, thumbnailUrl, sourceNode } = body as {
      name?: string;
      modelUrl?: string | null;
      modelType?: string | null;
      thumbnailUrl?: string | null;
      sourceNode?: string;
    };

    if (!name && !sourceNode) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const entries = await readHistory();

    const id = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const entry: HistoryEntry = {
      id,
      name: name || `${sourceNode || 'Model'}_${now.toISOString().slice(0, 19).replace(/[T:]/g, '-')}`,
      modelUrl: modelUrl || null,
      modelType: modelType || null,
      thumbnailUrl: thumbnailUrl || null,
      sourceNode: sourceNode || 'unknown',
      createdAt: now.toISOString(),
    };

    entries.push(entry);
    await writeHistory(entries);

    return NextResponse.json({ success: true, entry });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to add history record';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/model-history
 * Deletes a history entry by id (?id=xxx or JSON body { id }), or clears all records (?all=true).
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    if (searchParams.get('all') === 'true') {
      const entries = await readHistory();
      await writeHistory([]);
      return NextResponse.json({ success: true, deletedCount: entries.length });
    }

    const idFromQuery = searchParams.get('id');

    let targetId: string | null = idFromQuery;

    // Also support body-based id
    if (!targetId) {
      try {
        const body = await request.json();
        targetId = body.id || null;
      } catch {
        // No body
      }
    }

    if (!targetId) {
      return NextResponse.json({ error: 'Missing history record ID or all=true' }, { status: 400 });
    }

    const entries = await readHistory();
    const index = entries.findIndex((e) => e.id === targetId);
    if (index === -1) {
      return NextResponse.json({ error: 'History record not found' }, { status: 404 });
    }

    entries.splice(index, 1);
    await writeHistory(entries);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete history record';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
