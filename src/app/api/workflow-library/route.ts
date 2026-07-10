import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { DEFAULT_WORKFLOW_ID, createDefaultWorkflowEntry } from '@/lib/default-workflow';

const WORKFLOWS_FILE = path.join(process.cwd(), 'public', 'workflow-library', 'workflows.json');

export interface WorkflowEntry {
  id: string;
  name: string;
  nodes: unknown[];
  edges: unknown[];
  createdAt: string;
  updatedAt: string;
  readonly?: boolean;
  preset?: boolean;
}

async function readWorkflows(): Promise<WorkflowEntry[]> {
  try {
    const data = await readFile(WORKFLOWS_FILE, 'utf-8');
    return (JSON.parse(data) as WorkflowEntry[]).filter((entry) => entry.id !== DEFAULT_WORKFLOW_ID);
  } catch {
    return [];
  }
}

async function writeWorkflows(entries: WorkflowEntry[]): Promise<void> {
  await mkdir(path.dirname(WORKFLOWS_FILE), { recursive: true });
  await writeFile(WORKFLOWS_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

/**
 * GET /api/workflow-library
 * Returns all saved workflows sorted by updatedAt descending (newest first).
 */
export async function GET() {
  try {
    const entries = await readWorkflows();
    entries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return NextResponse.json({ success: true, entries: [createDefaultWorkflowEntry(), ...entries] });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to read workflow list';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/workflow-library
 * Saves a new workflow.
 *
 * Body:
 * {
 *   name: string,
 *   nodes: unknown[],
 *   edges: unknown[],
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, nodes, edges } = body as {
      name?: string;
      nodes?: unknown[];
      edges?: unknown[];
    };

    if (!name || !nodes || !edges) {
      return NextResponse.json({ error: 'Missing required parameters (name, nodes, edges)' }, { status: 400 });
    }

    const entries = await readWorkflows();
    const now = new Date().toISOString();
    const id = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const entry: WorkflowEntry = {
      id,
      name,
      nodes,
      edges,
      createdAt: now,
      updatedAt: now,
    };

    entries.push(entry);
    await writeWorkflows(entries);

    return NextResponse.json({ success: true, entry });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to save workflow';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/workflow-library
 * Renames a workflow.
 *
 * Body:
 * {
 *   id: string,
 *   name: string,
 * }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, name } = body as { id?: string; name?: string };

    if (!id || !name) {
      return NextResponse.json({ error: 'Missing required parameters (id, name)' }, { status: 400 });
    }

    if (id === DEFAULT_WORKFLOW_ID) {
      return NextResponse.json({ error: 'Default workflow preset cannot be renamed' }, { status: 403 });
    }

    const entries = await readWorkflows();
    const index = entries.findIndex((e) => e.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
    }

    entries[index].name = name;
    entries[index].updatedAt = new Date().toISOString();
    await writeWorkflows(entries);

    return NextResponse.json({ success: true, entry: entries[index] });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to rename workflow';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/workflow-library
 * Deletes a workflow entry by id (?id=xxx), or clears all saved workflows (?all=true).
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    if (searchParams.get('all') === 'true') {
      const entries = await readWorkflows();
      await writeWorkflows([]);
      return NextResponse.json({ success: true, deletedCount: entries.length });
    }

    const targetId = searchParams.get('id');

    if (!targetId) {
      return NextResponse.json({ error: 'Missing workflow ID or all=true' }, { status: 400 });
    }

    if (targetId === DEFAULT_WORKFLOW_ID) {
      return NextResponse.json({ error: 'Default workflow preset cannot be deleted' }, { status: 403 });
    }

    const entries = await readWorkflows();
    const index = entries.findIndex((e) => e.id === targetId);
    if (index === -1) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
    }

    entries.splice(index, 1);
    await writeWorkflows(entries);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete workflow';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
