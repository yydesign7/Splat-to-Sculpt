import path from 'path';
import { copyFile, mkdir } from 'fs/promises';
import { parseEphemeralFileUrl, ephemeralFileAbsPath } from '@/lib/ephemeral-storage';

const publicRoot = () => path.join(process.cwd(), 'public');

/**
 * If URL points at /api/ephemeral-file, copy that file into public/asset-published/<assetId>/
 * and return the new public URL. Otherwise returns the input unchanged.
 */
export async function publishUrlToPublicIfEphemeral(
  url: string | null,
  assetId: string,
): Promise<string | null> {
  if (!url) return null;
  const parsed = parseEphemeralFileUrl(url);
  if (!parsed) return url;

  const base = path.basename(parsed.rel) || 'file.bin';
  const destDir = path.join(publicRoot(), 'asset-published', assetId);
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, base);
  const src = ephemeralFileAbsPath(parsed.sessionId, parsed.rel);
  await copyFile(src, dest);
  return `/asset-published/${assetId}/${base}`;
}
