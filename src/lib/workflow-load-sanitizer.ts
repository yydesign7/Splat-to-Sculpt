import type { Edge, Node } from '@xyflow/react';

export function sanitizeLoadedWorkflowGraph(
  nodes: Node[],
  edges: Edge[],
): { nodes: Node[]; edges: Edge[] } {
  const sanitizedNodes = nodes
    .filter((node) => node.type !== 'material')
    .map((node) => {
      const { layerFiles: _legacyLayerFiles, ...dataWithoutLayerFiles } = node.data as Record<string, unknown>;
      void _legacyLayerFiles;

      if (node.type === 'gaussianSplat') {
        const { layerNames: _legacyLayerNames, ...gaussianData } = dataWithoutLayerFiles;
        void _legacyLayerNames;
        return { ...node, data: gaussianData };
      }

      if (node.type === 'modelGeneration') {
        const { textureUrl: _legacyMaterialInput, ...meshData } = dataWithoutLayerFiles;
        void _legacyMaterialInput;
        return { ...node, data: meshData };
      }

      return { ...node, data: dataWithoutLayerFiles };
    });

  const retainedNodeIds = new Set(sanitizedNodes.map((node) => node.id));
  const stickyNodeIds = new Set(
    sanitizedNodes.filter((node) => node.type === 'stickyNote').map((node) => node.id),
  );
  const sanitizedEdges = edges.filter(
    (edge) =>
      retainedNodeIds.has(edge.source) &&
      retainedNodeIds.has(edge.target) &&
      !stickyNodeIds.has(edge.source) &&
      !stickyNodeIds.has(edge.target) &&
      edge.sourceHandle !== 'texture-output' &&
      edge.targetHandle !== 'texture',
  );

  return { nodes: sanitizedNodes, edges: sanitizedEdges };
}
