import { expect, test } from "bun:test";
import { boxesIntersect, placeEdgeLabel, type Box } from "../web/arch-layout.ts";

test("edge label moves out of a node at the segment midpoint", () => {
  const nodes: Box[] = [
    { x: 0, y: 20, width: 100, height: 40 },
    { x: 300, y: 20, width: 100, height: 40 },
    { x: 165, y: 20, width: 70, height: 40 },
  ];
  const placement = placeEdgeLabel({
    from: { x: 100, y: 40 },
    to: { x: 300, y: 40 },
    textBox: { x: -33, y: -6, width: 66, height: 12 },
    nodes,
    labels: [],
    canvas: { x: 0, y: 0, width: 400, height: 120 },
  });

  expect(placement).not.toBeNull();
  if (!placement) return;
  expect(nodes.every((node) => !boxesIntersect(placement.box, node))).toBe(true);
  expect(placement.x === 200 && placement.y === 40).toBe(false);
});

test("edge labels reserve separate clear areas", () => {
  const request = {
    from: { x: 100, y: 40 },
    to: { x: 300, y: 40 },
    textBox: { x: -25, y: -6, width: 50, height: 12 },
    nodes: [
      { x: 0, y: 20, width: 100, height: 40 },
      { x: 300, y: 20, width: 100, height: 40 },
    ],
    canvas: { x: 0, y: 0, width: 400, height: 120 },
  };
  const first = placeEdgeLabel({ ...request, labels: [] });
  expect(first).not.toBeNull();
  if (!first) return;
  const second = placeEdgeLabel({ ...request, labels: [first.box] });
  expect(second).not.toBeNull();
  if (!second) return;
  expect(boxesIntersect(first.box, second.box)).toBe(false);
  expect(request.nodes.every((node) => !boxesIntersect(second.box, node))).toBe(true);
});
