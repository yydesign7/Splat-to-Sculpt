import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEntryViewport, getVisibleCanvasRect } from './workflow-entry-viewport';

const anchor = { x: 50, y: 80, width: 280, height: 300 };

test('entry is readable and clear of an overlapping sidebar', () => {
  const visible = getVisibleCanvasRect(
    { x: 0, y: 50, width: 1440, height: 850 },
    { x: 0, y: 50, width: 276, height: 850 },
  );
  assert.deepEqual(calculateEntryViewport({ anchor, visible }), { x: 263, y: -24, zoom: 0.9 });
});

test('a sidebar outside the canvas does not reduce its visible width', () => {
  assert.deepEqual(getVisibleCanvasRect(
    { x: 276, y: 50, width: 1164, height: 850 },
    { x: 0, y: 50, width: 276, height: 850 },
  ), { x: 0, y: 0, width: 1164, height: 850 });
});

test('narrow canvas fits the entry without negative zoom and empty canvas waits', () => {
  const result = calculateEntryViewport({ anchor, visible: { x: 56, y: 0, width: 250, height: 700 } });
  assert.ok(result);
  assert.ok(result.zoom < 0.85 && result.zoom > 0);
  assert.ok(result.x + (anchor.x + anchor.width) * result.zoom <= 306);
  assert.equal(calculateEntryViewport({ anchor, visible: { x: 0, y: 0, width: 0, height: 0 } }), null);
});
