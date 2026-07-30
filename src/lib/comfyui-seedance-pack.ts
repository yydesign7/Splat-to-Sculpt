import path from 'path';
import { access } from 'fs/promises';
import { detectComfyFoldersFromSystemStats } from './comfyui-workflow';

export const SEEDANCE_PACK_ROOT = path.join(process.cwd(), 'vendor', 'comfyui', 'seedance2');

export const SEEDANCE_CUSTOM_NODE_DIRS = [
  'seedance_3d_multiview',
  'seedance_ad_studio',
] as const;

export const SEEDANCE_WORKFLOW_FILES = [
  'Seedance2_3Dmodel_to_image_video.json',
] as const;

export const REQUIRED_SEEDANCE_NODE_TYPES = [
  'Seedance3DModelLoader',
  'Seedance3DModelMultiView',
  'ByteDance2ReferenceNode',
  'SaveVideo',
] as const;

export type SeedanceInstallFolders = {
  customNodesDir: string | null;
  workflowsDir: string | null;
};

function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[\\/]+$/, '');
}

function dirnameOf(value: string | null): string | null {
  const cleaned = cleanPath(value);
  if (!cleaned) return null;
  const slashIndex = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  if (slashIndex < 0) return null;
  if (slashIndex === 0) return '/';
  return cleanPath(cleaned.slice(0, slashIndex));
}

function joinPath(base: string | null, child: string): string | null {
  const cleanedBase = cleanPath(base);
  if (!cleanedBase) return null;
  if (cleanedBase === '/') return `/${child}`;
  return `${cleanedBase}/${child}`;
}

function getSystemArgv(systemStats: unknown): string[] {
  if (!systemStats || typeof systemStats !== 'object') return [];
  const system = (systemStats as Record<string, unknown>).system;
  if (!system || typeof system !== 'object') return [];
  const argv = (system as Record<string, unknown>).argv;
  return Array.isArray(argv) ? argv.filter((arg): arg is string => typeof arg === 'string') : [];
}

function hasArg(argv: string[], flag: string): boolean {
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export function deriveSeedanceInstallFolders(systemStats: unknown): SeedanceInstallFolders {
  const detected = detectComfyFoldersFromSystemStats(systemStats);
  const argv = getSystemArgv(systemStats);
  const hasExplicitBaseDir = hasArg(argv, '--base-directory');
  const dataDir = hasExplicitBaseDir
    ? detected.baseDir
    : dirnameOf(detected.inputDir) || dirnameOf(detected.outputDir) || detected.baseDir;
  return {
    customNodesDir: cleanPath(process.env.COMFYUI_CUSTOM_NODES_DIR) || joinPath(dataDir, 'custom_nodes'),
    workflowsDir: cleanPath(process.env.COMFYUI_WORKFLOWS_DIR) || joinPath(dataDir, 'user/default/workflows'),
  };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function readLoadedNodeTypes(objectInfo: unknown): string[] {
  if (!objectInfo || typeof objectInfo !== 'object') return [];
  return Object.keys(objectInfo as Record<string, unknown>);
}

export function missingRequiredNodeTypes(loadedNodeTypes: string[]): string[] {
  const loaded = new Set(loadedNodeTypes);
  return REQUIRED_SEEDANCE_NODE_TYPES.filter((nodeType) => !loaded.has(nodeType));
}
