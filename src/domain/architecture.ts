import { z } from "zod";

export const Relation = z.enum([
  "flows_to",
  "depends_on",
  "implements",
  "calls",
  "creates",
  "persists",
  "reads",
  "writes",
  "wraps",
  "validates",
  "routes_to",
]);
export type Relation = z.infer<typeof Relation>;

export const NodeKind = z.enum(["data", "function", "class", "interface", "infra", "external"]);

export const ArchitectureNode = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: NodeKind,
  col: z.number().int().min(0).max(8),
  row: z.number().int().min(0).max(8),
});
export type ArchitectureNode = z.infer<typeof ArchitectureNode>;

export const ArchitectureEdge = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  rel: Relation,
});
export type ArchitectureEdge = z.infer<typeof ArchitectureEdge>;

export const ArchitectureGraph = z.strictObject({
  nodes: z.array(ArchitectureNode).min(1),
  edges: z.array(ArchitectureEdge),
});
export type ArchitectureGraph = z.infer<typeof ArchitectureGraph>;
