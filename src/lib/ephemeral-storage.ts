import path from 'path';
import { mkdir, rm } from 'fs/promises';
import type { NextRequest } from 'next/server';

/** Workflow session files (not served from /public). Gitignored. */
export const EPHEMERAL_ROOT = path.join(process.cwd(), '.data', 'ephemeral');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidEphemeralSessionId(s: string | null | undefined): s is string {
  return !!s && UUID_RE.test(s);
}

export function getEphemeralSessionFromRequest(request: NextRequest): string | null {
  const h = request.headers.get('x-ephemeral-session-id') || request.headers.get('X-Ephemeral-Session-Id');
  return isValidEphemeralSessionId(h) ? h : null;
}

export function getSessionRoot(sessionId: string): string {
  if (!isValidEphemeralSessionId(sessionId)) throw new Error('Invalid ephemeral session id');
  return path.join(EPHEMERAL_ROOT, sessionId);
}

export async function ensureSessionRoot(sessionId: string): Promise<string> {
  const root = getSessionRoot(sessionId);
  await mkdir(root, { recursive: true });
  return root;
}

export async function cleanupEphemeralSession(sessionId: string): Promise<void> {
  if (!isValidEphemeralSessionId(sessionId)) return;
  await rm(getSessionRoot(sessionId), { recursive: true, force: true }).catch(() => {});
}

export function buildEphemeralFileUrl(sessionId: string, relPath: string): string {
  const rel = relPath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!rel || rel.includes('..')) throw new Error('Invalid ephemeral rel path');
  return `/api/ephemeral-file?sid=${encodeURIComponent(sessionId)}&rel=${encodeURIComponent(rel)}`;
}

export function parseEphemeralFileUrl(fileUrl: string): { sessionId: string; rel: string } | null {
  if (!fileUrl || typeof fileUrl !== 'string') return null;
  try {
    const base = fileUrl.startsWith('http://') || fileUrl.startsWith('https://')
      ? fileUrl
      : `http://127.0.0.1${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}`;
    const u = new URL(base);
    if (!u.pathname.endsWith('/api/ephemeral-file') && u.pathname !== '/api/ephemeral-file') {
      return null;
    }
    const sid = u.searchParams.get('sid');
    const rel = u.searchParams.get('rel');
    if (!sid || rel === null || rel === '') return null;
    if (rel.includes('..') || path.isAbsolute(rel)) return null;
    if (!isValidEphemeralSessionId(sid)) return null;
    return { sessionId: sid, rel };
  } catch {
    return null;
  }
}

export function ephemeralFileAbsPath(sessionId: string, rel: string): string {
  const root = path.normalize(getSessionRoot(sessionId));
  const resolved = path.normalize(path.join(root, rel));
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error('Path escape');
  }
  return resolved;
}

const PUBLIC_URL_PREFIXES = [
  '/videos/',
  '/frames/',
  '/pointclouds/',
  '/meshes/',
  '/merged-glb/',
  '/blender-output/',
  '/asset-published/',
  '/glb-processed/',
  '/obj-processed/',
  '/textures/',
  '/rotation-videos/',
  '/uploads/',
  '/blender-organized/',
] as const;

/**
 * Resolve a client-visible media URL to an absolute filesystem path.
 * Supports ephemeral API URLs and legacy paths under /public.
 */
export function resolveClientMediaUrlToFilesystem(clientPath: string): string {
  const trimmed = (clientPath || '').trim();
  if (!trimmed) throw new Error('Empty media path');

  const parsed = parseEphemeralFileUrl(trimmed);
  if (parsed) return ephemeralFileAbsPath(parsed.sessionId, parsed.rel);

  if (path.isAbsolute(trimmed)) {
    if (PUBLIC_URL_PREFIXES.some((p) => trimmed.startsWith(p))) {
      return path.join(process.cwd(), 'public', trimmed.replace(/^\/+/, ''));
    }
    return trimmed;
  }

  const p = trimmed.replace(/\\/g, '/');
  if (p.includes('..')) throw new Error('Invalid path');
  return path.join(process.cwd(), 'public', p);
}
