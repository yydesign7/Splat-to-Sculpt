import type { Edge, Node } from '@xyflow/react';
import {
  WORKFLOW_NODE_REGISTRY,
  getWorkflowNodeDefinition,
  isWorkflowNodeType,
} from './node-registry';
import type { WorkflowNodeDefinition, WorkflowNodeType, WorkflowPortDefinition } from './types';

export type WorkflowDiagnosticCode =
  | 'DUPLICATE_NODE_ID'
  | 'UNKNOWN_NODE_TYPE'
  | 'DANGLING_EDGE'
  | 'UNKNOWN_SOURCE_HANDLE'
  | 'UNKNOWN_TARGET_HANDLE'
  | 'INCOMPATIBLE_PORTS'
  | 'MULTIPLE_SINGLE_INPUTS'
  | 'GRAPH_CYCLE';

export interface WorkflowDiagnostic {
  code: WorkflowDiagnosticCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
  handle?: string | null;
}

export interface CompiledWorkflowGraph {
  nodes: Node[];
  edges: Edge[];
  nodeById: Record<string, Node>;
  definitionsByNodeId: Record<string, WorkflowNodeDefinition>;
  incomingEdgesByNodeId: Record<string, Edge[]>;
  outgoingEdgesByNodeId: Record<string, Edge[]>;
  executableNodeIds: string[];
  annotationNodeIds: string[];
  terminalNodeIds: string[];
  topologicalOrder: string[];
}

export type CompileWorkflowResult =
  | { ok: true; graph: CompiledWorkflowGraph; diagnostics: [] }
  | { ok: false; diagnostics: WorkflowDiagnostic[] };

function findPort(
  ports: readonly WorkflowPortDefinition[],
  handle: string | null | undefined,
): WorkflowPortDefinition | null {
  if (!handle) return null;
  return ports.find((port) => port.handle === handle) ?? null;
}

function isCompatiblePort(
  source: WorkflowPortDefinition,
  target: WorkflowPortDefinition,
): boolean {
  if (source.valueKind === target.valueKind) return true;
  if (target.valueKind === 'model') {
    return source.valueKind === 'splat' || source.valueKind === 'pointcloud';
  }
  return false;
}

function emptyEdgeMap(nodeIds: string[]): Record<string, Edge[]> {
  return Object.fromEntries(nodeIds.map((id) => [id, []]));
}

function buildTopologicalOrder(
  nodeIds: string[],
  edges: Edge[],
): { order: string[]; hasCycle: boolean } {
  const nodeIdSet = new Set(nodeIds);
  const inDegree = Object.fromEntries(nodeIds.map((id) => [id, 0]));
  const outgoing = emptyEdgeMap(nodeIds);

  for (const edge of edges) {
    if (!nodeIdSet.has(edge.source) || !nodeIdSet.has(edge.target)) continue;
    inDegree[edge.target] = (inDegree[edge.target] ?? 0) + 1;
    outgoing[edge.source]?.push(edge);
  }

  const queue = nodeIds.filter((id) => inDegree[id] === 0);
  const order: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    order.push(current);
    for (const edge of outgoing[current] ?? []) {
      inDegree[edge.target] -= 1;
      if (inDegree[edge.target] === 0) queue.push(edge.target);
    }
  }

  return { order, hasCycle: order.length !== nodeIds.length };
}

export function compileWorkflowGraph(nodes: Node[], edges: Edge[]): CompileWorkflowResult {
  const diagnostics: WorkflowDiagnostic[] = [];
  const nodeById: Record<string, Node> = {};
  const definitionsByNodeId: Record<string, WorkflowNodeDefinition> = {};
  const duplicateIds = new Set<string>();

  for (const node of nodes) {
    if (nodeById[node.id]) {
      duplicateIds.add(node.id);
      diagnostics.push({
        code: 'DUPLICATE_NODE_ID',
        message: `Duplicate node id "${node.id}"`,
        nodeId: node.id,
      });
      continue;
    }
    nodeById[node.id] = node;
    const definition = getWorkflowNodeDefinition(node.type);
    if (!definition) {
      diagnostics.push({
        code: 'UNKNOWN_NODE_TYPE',
        message: `Unknown node type "${node.type ?? 'undefined'}"`,
        nodeId: node.id,
      });
      continue;
    }
    definitionsByNodeId[node.id] = definition;
  }

  const executableNodeIds = nodes
    .filter((node) => !duplicateIds.has(node.id) && isWorkflowNodeType(node.type))
    .filter((node) => WORKFLOW_NODE_REGISTRY[node.type as WorkflowNodeType].mode !== 'annotation')
    .map((node) => node.id);
  const annotationNodeIds = nodes
    .filter((node) => !duplicateIds.has(node.id) && isWorkflowNodeType(node.type))
    .filter((node) => WORKFLOW_NODE_REGISTRY[node.type as WorkflowNodeType].mode === 'annotation')
    .map((node) => node.id);

  const incomingEdgesByNodeId = emptyEdgeMap(nodes.map((node) => node.id));
  const outgoingEdgesByNodeId = emptyEdgeMap(nodes.map((node) => node.id));
  const executableNodeIdSet = new Set(executableNodeIds);
  const executableEdges: Edge[] = [];
  const singleInputKeys = new Set<string>();

  for (const edge of edges) {
    const sourceNode = nodeById[edge.source];
    const targetNode = nodeById[edge.target];
    if (!sourceNode || !targetNode) {
      diagnostics.push({
        code: 'DANGLING_EDGE',
        message: `Edge "${edge.id}" references a missing node`,
        edgeId: edge.id,
      });
      continue;
    }

    const sourceDefinition = definitionsByNodeId[edge.source];
    const targetDefinition = definitionsByNodeId[edge.target];
    if (!sourceDefinition || !targetDefinition) continue;
    if (sourceDefinition.mode === 'annotation' || targetDefinition.mode === 'annotation') continue;

    incomingEdgesByNodeId[edge.target]?.push(edge);
    outgoingEdgesByNodeId[edge.source]?.push(edge);
    executableEdges.push(edge);

    const sourcePort = findPort(sourceDefinition.outputs, edge.sourceHandle);
    const targetPort = findPort(targetDefinition.inputs, edge.targetHandle);
    if (!sourcePort) {
      diagnostics.push({
        code: 'UNKNOWN_SOURCE_HANDLE',
        message: `Unknown source handle "${edge.sourceHandle ?? 'none'}"`,
        edgeId: edge.id,
        nodeId: edge.source,
        handle: edge.sourceHandle,
      });
    }
    if (!targetPort) {
      diagnostics.push({
        code: 'UNKNOWN_TARGET_HANDLE',
        message: `Unknown target handle "${edge.targetHandle ?? 'none'}"`,
        edgeId: edge.id,
        nodeId: edge.target,
        handle: edge.targetHandle,
      });
    }
    if (sourcePort && targetPort && !isCompatiblePort(sourcePort, targetPort)) {
      diagnostics.push({
        code: 'INCOMPATIBLE_PORTS',
        message: `Cannot connect ${sourcePort.valueKind} to ${targetPort.valueKind}`,
        edgeId: edge.id,
      });
    }
    if (targetPort?.required) {
      const inputKey = `${edge.target}:${targetPort.handle}`;
      if (singleInputKeys.has(inputKey)) {
        diagnostics.push({
          code: 'MULTIPLE_SINGLE_INPUTS',
          message: `Multiple edges feed required input "${targetPort.handle}"`,
          edgeId: edge.id,
          nodeId: edge.target,
          handle: targetPort.handle,
        });
      }
      singleInputKeys.add(inputKey);
    }
  }

  const { order, hasCycle } = buildTopologicalOrder(executableNodeIds, executableEdges);
  if (hasCycle) {
    diagnostics.push({
      code: 'GRAPH_CYCLE',
      message: 'Workflow graph contains a cycle',
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const terminalNodeIds = executableNodeIds.filter(
    (nodeId) => (outgoingEdgesByNodeId[nodeId] ?? []).filter((edge) => executableNodeIdSet.has(edge.target)).length === 0,
  );

  return {
    ok: true,
    diagnostics: [],
    graph: {
      nodes,
      edges,
      nodeById,
      definitionsByNodeId,
      incomingEdgesByNodeId,
      outgoingEdgesByNodeId,
      executableNodeIds,
      annotationNodeIds,
      terminalNodeIds,
      topologicalOrder: order,
    },
  };
}
