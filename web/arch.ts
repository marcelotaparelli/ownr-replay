import type { ArchitectureGraph, Relation } from "../src/domain/architecture.ts";
import { architectureDiff, edgeKey } from "../src/domain/architecture-diff.ts";
import { escapeHtml, h } from "./dom.ts";

const NODE_W = 136;
const NODE_H = 36;
const COL_W = 184;
const ROW_H = 64;
const PAD = 12;

const RELATION_LABEL: Record<Relation, string> = {
  flows_to: "",
  depends_on: "depende de",
  implements: "implementa",
  calls: "chama",
  creates: "produz",
  persists: "persiste",
  reads: "lê",
  writes: "grava",
  wraps: "envolve",
  validates: "valida",
  routes_to: "roteia",
};

/** Small hand-positioned diagram; what this stage adds is highlighted. */
/** onNode: nodes become buttons (click, Enter or Space) that open the node's real code. */
export function architectureView(graph: ArchitectureGraph, previous: ArchitectureGraph | undefined, onNode?: (nodeId: string) => void): HTMLElement {
  const diff = architectureDiff(previous, graph);
  const newNodes = new Set(diff.newNodes);
  const newEdges = new Set(diff.newEdges);
  const at = new Map(graph.nodes.map((n) => [n.id, { x: PAD + n.col * COL_W, y: PAD + n.row * ROW_H }]));
  const width = PAD * 2 + Math.max(...graph.nodes.map((n) => n.col)) * COL_W + NODE_W;
  const height = PAD * 2 + Math.max(...graph.nodes.map((n) => n.row)) * ROW_H + NODE_H;

  const edges = graph.edges
    .map((edge) => {
      const from = at.get(edge.from);
      const to = at.get(edge.to);
      if (!from || !to) return "";
      const [x1, y1, x2, y2] =
        from.x === to.x
          ? [from.x + NODE_W / 2, from.y + (to.y > from.y ? NODE_H : 0), to.x + NODE_W / 2, to.y + (to.y > from.y ? 0 : NODE_H)]
          : [from.x + (to.x > from.x ? NODE_W : 0), from.y + NODE_H / 2, to.x + (to.x > from.x ? 0 : NODE_W), to.y + NODE_H / 2];
      const label = RELATION_LABEL[edge.rel];
      const cls = newEdges.has(edgeKey(edge)) ? "edge new" : "edge";
      return `<g class="${cls}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow)"/>${
        label ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle">${label}</text>` : ""
      }</g>`;
    })
    .join("");

  const nodes = graph.nodes
    .map((node) => {
      const p = at.get(node.id);
      if (!p) return "";
      const cls = `node ${node.kind}${newNodes.has(node.id) ? " new" : ""}`;
      const button = onNode ? ` data-node="${escapeHtml(node.id)}" tabindex="0" role="button" aria-label="Ver o código real de ${escapeHtml(node.label)}"` : "";
      return `<g class="${cls}"${button}><rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="6"/><text x="${p.x + NODE_W / 2}" y="${p.y + NODE_H / 2 + 4}" text-anchor="middle">${escapeHtml(node.label)}</text></g>`;
    })
    .join("");

  const svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Arquitetura desta etapa">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>${edges}${nodes}</svg>`;

  const added = graph.nodes.filter((n) => newNodes.has(n.id)).map((n) => n.label);
  const canvas = h("div", { class: "arch-canvas" + (onNode ? " navigable" : ""), html: svg });
  if (onNode) {
    const nodeOf = (event: Event) => (event.target instanceof Element ? event.target.closest<SVGGElement>("[data-node]")?.dataset.node : undefined);
    canvas.addEventListener("click", (event) => {
      const id = nodeOf(event);
      if (id) onNode(id);
    });
    canvas.addEventListener("keydown", (event) => {
      const id = nodeOf(event);
      if (id && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        onNode(id);
      }
    });
  }
  return h(
    "figure",
    { class: "arch" },
    canvas,
    added.length && previous ? h("figcaption", {}, h("span", { class: "dot-new" }), " novo nesta etapa: ", added.join(", ")) : null,
    onNode ? h("figcaption", { class: "muted" }, "Clique em um bloco para ver o código real correspondente.") : null,
  );
}
