import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupAllEphemeralSessions, cleanupOldEphemeralSessions } from './ephemeral-cleanup';

async function createSession(root: string, name: string, mtimeMs: number): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'keep.txt'), 'x');
  const date = new Date(mtimeMs);
  await utimes(dir, date, date);
  return dir;
}

test('startup cleanup removes only ephemeral sessions older than the ttl', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ephemeral-cleanup-'));
  try {
    const nowMs = Date.UTC(2026, 6, 30, 12, 0, 0);
    await createSession(root, 'old-session', nowMs - (4 * 24 * 60 * 60 * 1000));
    await createSession(root, 'fresh-session', nowMs - (2 * 24 * 60 * 60 * 1000));

    const result = await cleanupOldEphemeralSessions(root, {
      ttlMs: 3 * 24 * 60 * 60 * 1000,
      nowMs,
    });

    const remaining = await readdir(root);
    assert.deepEqual(result.removed.sort(), ['old-session']);
    assert.deepEqual(remaining.sort(), ['fresh-session']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exit cleanup clears all ephemeral session folders but keeps the root directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ephemeral-cleanup-'));
  try {
    const nowMs = Date.UTC(2026, 6, 30, 12, 0, 0);
    await createSession(root, 'session-a', nowMs);
    await createSession(root, 'session-b', nowMs);

    const result = await cleanupAllEphemeralSessions(root);

    assert.deepEqual(result.removed.sort(), ['session-a', 'session-b']);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
