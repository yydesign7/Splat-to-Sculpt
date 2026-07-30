import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  getOpenFolderCommand,
  isOpenableEphemeralFolderType,
  isValidEphemeralFolderId,
  resolveOpenableEphemeralFolderPath,
} from './open-ephemeral-folder';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';

test('validates openable ephemeral folder inputs', () => {
  assert.equal(isOpenableEphemeralFolderType('frames'), true);
  assert.equal(isOpenableEphemeralFolderType('meshes'), false);
  assert.equal(isValidEphemeralFolderId(FOLDER_ID), true);
  assert.equal(isValidEphemeralFolderId('../frames'), false);
  assert.equal(isValidEphemeralFolderId(''), false);
});

test('resolves frames folder inside current ephemeral session', () => {
  const folderPath = resolveOpenableEphemeralFolderPath({
    sessionId: SESSION_ID,
    folderType: 'frames',
    folderId: FOLDER_ID,
  });

  assert.equal(
    folderPath,
    path.join(process.cwd(), '.data', 'ephemeral', SESSION_ID, 'frames', FOLDER_ID),
  );
});

test('rejects invalid folder ids before resolving a path', () => {
  assert.throws(
    () => resolveOpenableEphemeralFolderPath({
      sessionId: SESSION_ID,
      folderType: 'frames',
      folderId: '../escape',
    }),
    /Invalid folder id/,
  );
});

test('selects platform-specific open folder commands', () => {
  assert.deepEqual(getOpenFolderCommand('darwin', '/tmp/a'), { command: 'open', args: ['/tmp/a'] });
  assert.deepEqual(getOpenFolderCommand('win32', 'C:\\tmp\\a'), { command: 'explorer', args: ['C:\\tmp\\a'] });
  assert.deepEqual(getOpenFolderCommand('linux', '/tmp/a'), { command: 'xdg-open', args: ['/tmp/a'] });
});
