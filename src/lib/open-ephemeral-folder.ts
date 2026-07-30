import path from 'path';
import { getSessionRoot } from './ephemeral-storage';

export type OpenableEphemeralFolderType = 'frames';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidEphemeralFolderId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isOpenableEphemeralFolderType(value: unknown): value is OpenableEphemeralFolderType {
  return value === 'frames';
}

export function resolveOpenableEphemeralFolderPath(params: {
  sessionId: string;
  folderType: OpenableEphemeralFolderType;
  folderId: string;
}): string {
  if (!isOpenableEphemeralFolderType(params.folderType)) {
    throw new Error('Unsupported folder type');
  }
  if (!isValidEphemeralFolderId(params.folderId)) {
    throw new Error('Invalid folder id');
  }

  const root = path.normalize(getSessionRoot(params.sessionId));
  const resolved = path.normalize(path.join(root, params.folderType, params.folderId));
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error('Path escape');
  }
  return resolved;
}

export function getOpenFolderCommand(platform: NodeJS.Platform, folderPath: string): {
  command: string;
  args: string[];
} {
  if (platform === 'darwin') return { command: 'open', args: [folderPath] };
  if (platform === 'win32') return { command: 'explorer', args: [folderPath] };
  return { command: 'xdg-open', args: [folderPath] };
}
