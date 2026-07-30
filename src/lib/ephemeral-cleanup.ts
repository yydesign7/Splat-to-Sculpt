import { mkdir, readdir, rm, stat } from 'fs/promises';
import path from 'path';
import { EPHEMERAL_ROOT } from './ephemeral-storage';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EPHEMERAL_STARTUP_TTL_MS = 3 * DAY_MS;

export type EphemeralCleanupResult = {
  removed: string[];
  failed: Array<{ name: string; error: string }>;
};

async function listSessionDirectories(root: string): Promise<string[]> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function removeSessionDirectory(root: string, name: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, name);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (target !== resolvedRoot && !target.startsWith(rootWithSep)) {
    throw new Error('Refusing to remove path outside ephemeral root');
  }
  await rm(target, { recursive: true, force: true });
}

export async function cleanupOldEphemeralSessions(
  root = EPHEMERAL_ROOT,
  options: { ttlMs?: number; nowMs?: number } = {},
): Promise<EphemeralCleanupResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_EPHEMERAL_STARTUP_TTL_MS;
  const nowMs = options.nowMs ?? Date.now();
  const result: EphemeralCleanupResult = { removed: [], failed: [] };
  const sessionNames = await listSessionDirectories(root);

  for (const name of sessionNames) {
    try {
      const sessionPath = path.join(root, name);
      const info = await stat(sessionPath);
      if (nowMs - info.mtimeMs <= ttlMs) continue;
      await removeSessionDirectory(root, name);
      result.removed.push(name);
    } catch (error: unknown) {
      result.failed.push({
        name,
        error: error instanceof Error ? error.message : 'Unknown cleanup error',
      });
    }
  }

  return result;
}

export async function cleanupAllEphemeralSessions(root = EPHEMERAL_ROOT): Promise<EphemeralCleanupResult> {
  const result: EphemeralCleanupResult = { removed: [], failed: [] };
  const sessionNames = await listSessionDirectories(root);

  for (const name of sessionNames) {
    try {
      await removeSessionDirectory(root, name);
      result.removed.push(name);
    } catch (error: unknown) {
      result.failed.push({
        name,
        error: error instanceof Error ? error.message : 'Unknown cleanup error',
      });
    }
  }

  await mkdir(root, { recursive: true });
  return result;
}

export async function cleanupOldEphemeralSessionsOnStartup(): Promise<void> {
  const result = await cleanupOldEphemeralSessions();
  if (result.removed.length > 0 || result.failed.length > 0) {
    console.log(
      `[ephemeral-cleanup] startup removed ${result.removed.length} old session(s); failed ${result.failed.length}.`,
    );
  }
}

export function installEphemeralExitCleanup(): void {
  let cleaning = false;

  const cleanupAndExit = async (code: number) => {
    if (cleaning) return;
    cleaning = true;
    try {
      const result = await cleanupAllEphemeralSessions();
      console.log(
        `[ephemeral-cleanup] exit removed ${result.removed.length} session(s); failed ${result.failed.length}.`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown cleanup error';
      console.error('[ephemeral-cleanup] exit cleanup failed:', message);
    } finally {
      process.exit(code);
    }
  };

  process.once('SIGINT', () => {
    void cleanupAndExit(130);
  });
  process.once('SIGTERM', () => {
    void cleanupAndExit(143);
  });
}
