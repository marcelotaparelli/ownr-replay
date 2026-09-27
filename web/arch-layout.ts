export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

type LabelRequest = {
  from: Point;
  to: Point;
  textBox: Box;
  nodes: readonly Box[];
  labels: readonly Box[];
  canvas: Box;
};

export type LabelPlacement = { x: number; y: number; box: Box };

const LABEL_PAD_X = 6;
const LABEL_PAD_Y = 5;
const NODE_CLEARANCE = 4;
const LABEL_CLEARANCE = 4;
const ARROW_CLEARANCE = 10;

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function expand(box: Box, x: number, y: number): Box {
  return { x: box.x - x, y: box.y - y, width: box.width + 2 * x, height: box.height + 2 * y };
}

function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function pointInBox(point: Point, box: Box): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}

/** Find a clear pocket near the edge, using the browser-measured text and node boxes. */
export function placeEdgeLabel({ from, to, textBox, nodes, labels, canvas }: LabelRequest): LabelPlacement | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const normal = { x: -dy / length, y: dx / length };
  const samples = Math.max(9, Math.ceil(length / 12));
  const fractions = Array.from({ length: samples }, (_, index) => (index + 1) / (samples + 1))
    .sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5));

  for (const offset of [0, 16, -16, 32, -32, 48, -48, 64, -64, 80, -80, 96, -96]) {
    for (const fraction of fractions) {
      const x = from.x + dx * fraction + normal.x * offset;
      const y = from.y + dy * fraction + normal.y * offset;
      const box = expand({ x: x + textBox.x, y: y + textBox.y, width: textBox.width, height: textBox.height }, LABEL_PAD_X, LABEL_PAD_Y);
      if (!contains(canvas, box)) continue;
      if (nodes.some((node) => boxesIntersect(box, expand(node, NODE_CLEARANCE, NODE_CLEARANCE)))) continue;
      if (labels.some((label) => boxesIntersect(box, expand(label, LABEL_CLEARANCE, LABEL_CLEARANCE)))) continue;
      if (pointInBox(to, expand(box, ARROW_CLEARANCE, ARROW_CLEARANCE))) continue;
      return { x, y, box };
    }
  }
  return null;
}
