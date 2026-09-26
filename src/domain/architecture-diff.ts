// Pure graph helpers, kept apart from the Zod schemas so the browser bundle stays free of zod.
import type { ArchitectureEdge, ArchitectureGraph } from "./architecture.ts";

export const edgeKey = (edge: ArchitectureEdge): string => `${edge.from}>${edge.to}:${edge.rel}`;

/** What a stage adds on top of the previous stage's architecture. */
export function architectureDiff(
  before: ArchitectureGraph | undefined,
  after: ArchitectureGraph,
): { newNodes: string[]; newEdges: string[] } {
  const oldNodes = new Set(before?.nodes.map((node) => node.id));
  const oldEdges = new Set(before?.edges.map(edgeKey));
  return {
    newNodes: after.nodes.filter((node) => !oldNodes.has(node.id)).map((node) => node.id),
    newEdges: after.edges.map(edgeKey).filter((key) => !oldEdges.has(key)),
  };
}

/** Returns human-readable problems; empty means the graph is consistent. */
export function graphProblems(graph: ArchitectureGraph): string[] {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const problems: string[] = [];
  if (ids.size !== graph.nodes.length) problems.push("duplicate node id");
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) problems.push(`edge from unknown node ${edge.from}`);
    if (!ids.has(edge.to)) problems.push(`edge to unknown node ${edge.to}`);
  }
  return problems;
}
