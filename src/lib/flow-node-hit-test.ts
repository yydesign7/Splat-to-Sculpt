import { NODE_WIDTH, VIDEO_PREVIEW_NODE_WIDTH } from './node-config';

export type FlowPoint = {
  x: number;
  y: number;
};

export type FlowHitTestNode = {
  id: string;
  type?: string;
  position: FlowPoint;
  width?: number | null;
  height?: number | null;
  measured?: {
    width?: number | null;
    height?: number | null;
  } | null;
};

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function fallbackNodeSize(type: string | undefined): { width: number; height: number } {
  if (type === 'videoPreview') {
    return { width: VIDEO_PREVIEW_NODE_WIDTH, height: 470 };
  }
  if (type === 'comfyVideo') {
    return { width: NODE_WIDTH, height: 690 };
  }
  return { width: NODE_WIDTH, height: 200 };
}

function nodeSize(node: FlowHitTestNode): { width: number; height: number } {
  const fallback = fallbackNodeSize(node.type);
  return {
    width: positiveNumber(node.measured?.width) ?? positiveNumber(node.width) ?? fallback.width,
    height: positiveNumber(node.measured?.height) ?? positiveNumber(node.height) ?? fallback.height,
  };
}

export function findDropTargetNode<TNode extends FlowHitTestNode>(
  nodes: TNode[],
  point: FlowPoint,
): TNode | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!node) continue;
    const size = nodeSize(node);
    const right = node.position.x + size.width;
    const bottom = node.position.y + size.height;
    if (
      point.x >= node.position.x &&
      point.x <= right &&
      point.y >= node.position.y &&
      point.y <= bottom
    ) {
      return node;
    }
  }
  return null;
}
