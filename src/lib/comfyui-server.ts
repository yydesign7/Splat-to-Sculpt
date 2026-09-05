import { DEFAULT_COMFY_URL } from './comfyui-workflow';

export function normalizeComfyUrl(value: string | undefined | null): string {
  const url = new URL(value || DEFAULT_COMFY_URL);
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopback) {
    throw new Error('ComfyUI URL must point to localhost');
  }
  return url.toString().replace(/\/$/, '');
}

export async function fetchComfyJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && typeof (data as Record<string, unknown>).error === 'string'
        ? ((data as Record<string, unknown>).error as string)
        : `ComfyUI request failed with ${res.status}`;
    throw new Error(message);
  }
  return data;
}

export async function getComfySystemStats(comfyUrl: string, signal?: AbortSignal): Promise<unknown> {
  return fetchComfyJson(`${comfyUrl}/system_stats`, { signal });
}

export function isComfyConnectionFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return true;
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(record.code)) return true;
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.every((cause: unknown) => isComfyConnectionFailure(cause, depth + 1));
  }
  return isComfyConnectionFailure(record.cause, depth + 1);
}

export function readComfyVersion(systemStats: unknown): string | null {
  if (!systemStats || typeof systemStats !== 'object') return null;
  const root = systemStats as Record<string, unknown>;
  const system = root.system && typeof root.system === 'object' ? (root.system as Record<string, unknown>) : null;
  const candidates = [
    root.version,
    root.comfyui_version,
    system?.version,
    system?.comfyui_version,
    system?.comfyuiVersion,
  ];
  const version = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return typeof version === 'string' ? version : null;
}

export function getPromptId(data: unknown): string {
  if (!data || typeof data !== 'object') {
    throw new Error('ComfyUI did not return a prompt id');
  }
  const promptId = (data as Record<string, unknown>).prompt_id;
  if (typeof promptId !== 'string' && typeof promptId !== 'number') {
    throw new Error('ComfyUI did not return a prompt id');
  }
  return String(promptId);
}
