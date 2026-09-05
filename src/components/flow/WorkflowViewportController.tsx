'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { getViewportForBounds, useNodesInitialized, useReactFlow, type Node } from '@xyflow/react';
import { calculateEntryViewport, getVisibleCanvasRect, type ViewportRequest } from '@/lib/workflow-entry-viewport';

interface Props {
  request: ViewportRequest | null;
  nodes: Node[];
  canvasRef: RefObject<HTMLDivElement | null>;
  sidebarRef: RefObject<HTMLDivElement | null>;
  onApplied: (revision: number) => void;
}

export function WorkflowViewportController({ request, nodes, canvasRef, sidebarRef, onApplied }: Props): null {
  const initialized = useNodesInitialized();
  const { getNodes, getNode, getNodesBounds, setViewport, viewportInitialized } = useReactFlow();
  const applied = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!request || applied.current === request.revision || !viewportInitialized) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const apply = (): void => {
      if (applied.current === request.revision) return;
      const currentNodes = getNodes();
      if (currentNodes.length !== nodes.length || nodes.some((node) => {
        const current = getNode(node.id);
        return !current || current.position.x !== node.position.x || current.position.y !== node.position.y;
      })) return;
      if (nodes.length > 0 && !initialized) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      if (request.mode === 'restore') {
        void setViewport(request.viewport);
      } else if (request.mode === 'overview') {
        if (nodes.length > 0) {
          // fitView queues work for a later frame and could overwrite a newer entry request.
          void setViewport(getViewportForBounds(getNodesBounds(currentNodes), rect.width, rect.height, 0.1, 1, 0.2));
        }
      } else {
        const anchor = getNode(request.anchorId);
        if (anchor) {
          if (!anchor.measured?.width) return;
          const viewport = calculateEntryViewport({
            anchor: { ...anchor.position, width: anchor.measured.width, height: anchor.measured.height ?? 0 },
            visible: getVisibleCanvasRect(rect, sidebarRef.current?.getBoundingClientRect() ?? null),
          });
          if (!viewport) return;
          void setViewport(viewport);
        }
      }
      applied.current = request.revision;
      onApplied(request.revision);
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(canvas);
    if (sidebarRef.current) observer.observe(sidebarRef.current);
    return () => observer.disconnect();
  }, [request, nodes, initialized, viewportInitialized, canvasRef, sidebarRef, getNodes, getNode, getNodesBounds, setViewport, onApplied]);
  return null;
}
