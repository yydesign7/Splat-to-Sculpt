/**
 * Infer mesh model type from a client-visible URL (public path or /api/ephemeral-file?rel=...).
 */

export type ModelUrlType = 'glb' | 'fbx' | 'obj' | 'ply';

function typeFromFilename(filename: string): ModelUrlType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gltf') || lower.endsWith('.glb')) return 'glb';
  if (lower.endsWith('.fbx')) return 'fbx';
  if (lower.endsWith('.obj')) return 'obj';
  if (lower.endsWith('.ply')) return 'ply';
  return null;
}

/** Last path segment of a URL path (no query). */
function basenameFromPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  return parts.pop() ?? '';
}

/**
 * Infer model type from URL: normal paths (`/meshes/a.glb`), absolute URLs, or
 * `/api/ephemeral-file?sid=…&rel=…/file.glb` where the extension is in `rel`.
 */
export function inferModelTypeFromUrl(url: string): ModelUrlType | null {
  if (!url || typeof url !== 'string') return null;

  const pathOnly = url.split('?')[0] ?? '';
  const fromPath = typeFromFilename(basenameFromPath(pathOnly));
  if (fromPath) return fromPath;

  try {
    const u = new URL(url, 'http://127.0.0.1');
    const p = u.pathname.toLowerCase();
    if (p === '/api/ephemeral-file' || p.endsWith('/api/ephemeral-file')) {
      const rel = u.searchParams.get('rel');
      if (!rel) return null;
      const last = rel.split(/[/\\]/).filter(Boolean).pop() ?? '';
      return typeFromFilename(last);
    }
  } catch {
    /* invalid URL */
  }

  return null;
}
