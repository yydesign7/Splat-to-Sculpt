import type { Rect, Viewport } from '@xyflow/react';

export interface EntryViewportInput {
  anchor: Rect;
  visible: Rect;
}

export type ViewportRequest =
  | { revision: number; mode: 'entry'; anchorId: string }
  | { revision: number; mode: 'overview' }
  | { revision: number; mode: 'restore'; viewport: Viewport };

export function getVisibleCanvasRect(canvas: Rect, sidebar: Rect | null): Rect {
  const overlapsLeft = sidebar && sidebar.x <= canvas.x && sidebar.x + sidebar.width > canvas.x
    && sidebar.y < canvas.y + canvas.height && sidebar.y + sidebar.height > canvas.y;
  const inset = overlapsLeft ? Math.min(canvas.width, sidebar.x + sidebar.width - canvas.x) : 0;
  return { x: inset, y: 0, width: canvas.width - inset, height: canvas.height };
}

export function calculateEntryViewport({ anchor, visible }: EntryViewportInput): Viewport | null {
  if (visible.width <= 0 || visible.height <= 0 || anchor.width <= 0) return null;
  const padding = Math.min(32, visible.width * 0.1);
  const zoom = Math.max(0.1, Math.min(0.9, (visible.width - padding * 2) / anchor.width));
  return {
    x: visible.x + padding - anchor.x * zoom,
    y: visible.y + 48 - anchor.y * zoom,
    zoom,
  };
}
