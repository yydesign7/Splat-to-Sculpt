import { z } from 'zod';

export const SAVED_WORKFLOW_SCHEMA_VERSION = 2;

const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
}).passthrough();

export const SavedWorkflowNodeSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  position: PositionSchema,
  data: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export const SavedWorkflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  sourceHandle: z.string().nullable().optional(),
  target: z.string(),
  targetHandle: z.string().nullable().optional(),
}).passthrough();

export const SavedWorkflowGraphSchema = z.object({
  schemaVersion: z.number().optional(),
  nodes: z.array(SavedWorkflowNodeSchema),
  edges: z.array(SavedWorkflowEdgeSchema),
}).passthrough();

export type SavedWorkflowGraphInput = z.input<typeof SavedWorkflowGraphSchema>;
export type SavedWorkflowGraph = z.output<typeof SavedWorkflowGraphSchema> & {
  schemaVersion: typeof SAVED_WORKFLOW_SCHEMA_VERSION;
};
