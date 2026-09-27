import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Journey } from "../src/domain/journey.ts";
import { codeMapProblems, declarationsOf, indexRepository, originalDir, resolveNode, type NodeCode } from "../src/services/code-map.ts";
import { golden, testApp } from "./helpers.ts";

const journey = golden();
const index = indexRepository(originalDir(join(import.meta.dir, "../data/golden/ops-triage-ai")));
const node = (id: string, label?: string) => {
  const found = journey.stages.flatMap((s) => s.architecture?.nodes ?? []).find((n) => n.id === id && (label === undefined || n.label === label));
  if (!found) throw new Error(`no node ${id}`);
  return found;
};
const options = (code: NodeCode) => (code.status === "mapped" ? code.options.map((o) => `${o.path}#${o.symbol}:${o.startLine}-${o.endLine}`) : [`unmapped: ${code.reason}`]);

describe("architecture node → real code", () => {
  test("declarations: top-level symbols and class members, with the lines they span", () => {
    const source = 'export class A {\n  private readonly x = "{";\n  run(input: string): void {\n    if (input) {\n      return;\n    }\n  }\n}\nexport const B = 1;\n';
    expect(declarationsOf("a.ts", source).map((d) => [d.container ? `${d.container}.${d.symbol}` : d.symbol, d.startLine, d.endLine])).toEqual([
      ["A", 1, 8],
      ["A.run", 3, 7],
      ["B", 9, 9],
    ]);
  });

  test("Ticket opens TicketInput and TriageTicket opens its class, both at the pinned SHA", () => {
    expect(options(resolveNode(node("ticket", "Ticket"), journey, index))).toEqual(["src/domain/triage.ts#TicketInput:33-36"]);
    expect(options(resolveNode(node("triage-ticket"), journey, index))[0]).toBe("src/application/triage-ticket.ts#TriageTicket:24-45");
  });

  test("abbreviated or shared names show every relevant symbol instead of picking one", () => {
    expect(options(resolveNode(node("prisma"), journey, index))).toEqual([
      "src/infrastructure/persistence/prisma-triage-repositories.ts#PrismaTriageRunRepository:32-78",
      "src/infrastructure/persistence/prisma-triage-repositories.ts#PrismaFeedbackRepository:116-134",
    ]);
    expect(options(resolveNode(node("classify", "classify()"), journey, index)).length).toBeGreaterThan(1);
  });

  test("nodes with no real counterpart are unmapped, never guessed", () => {
    for (const [id, label] of [["text", "texto"], ["client", "Cliente HTTP"], ["postgres", "PostgreSQL"], ["ollama", "LLM (HTTP)"], ["memory", "InMemoryTriageRuns"]] as const) {
      expect(resolveNode(node(id, label), journey, index).status).toBe("unmapped");
    }
  });

  test("every option points into a real file, and name-based options start at a line that declares that name", () => {
    const nodes = new Map(journey.stages.flatMap((s) => s.architecture?.nodes ?? []).map((n) => [`${n.id}|${n.label}`, n]));
    for (const n of nodes.values()) {
      const code = resolveNode(n, journey, index);
      if (code.status !== "mapped") continue;
      for (const o of code.options) {
        const lines = (index.files.get(o.path) ?? "").split("\n");
        expect(o.endLine).toBeLessThanOrEqual(lines.length);
        expect(o.startLine).toBeLessThanOrEqual(o.endLine);
        if (o.basis !== "curated-ref") expect(lines[o.startLine - 1]).toContain(o.symbol.split(".").at(-1));
      }
    }
  });

  test("the explicit map is validated against the real repository", () => {
    expect(codeMapProblems(journey, index)).toEqual([]);
    const broken: Journey = { ...journey, codeMap: { ticket: [{ path: "src/domain/triage.ts", symbol: "Ticket" }], ghost: [{ path: "src/domain/triage.ts", symbol: "Category" }] } };
    expect(codeMapProblems(broken, index)).toEqual([
      'codeMap: "ticket" aponta para src/domain/triage.ts#Ticket, que não existe no repositório real',
      'codeMap: nó "ghost" não existe em nenhuma arquitetura',
    ]);
  });

  test("the API gives each stage only the components it already presents, with their real files", async () => {
    const { call } = testApp();
    const body = (await (await call("GET", "/api/stages/ops-triage-ai.02/architecture")).json()) as { nodes: NodeCode[]; files: Record<string, string>; repo: { sha: string } };
    expect(body.nodes.map((n) => n.nodeId)).toEqual(["ticket", "triage-ticket", "triage-classifier", "deterministic", "classify"]);
    expect(body.files["src/application/triage-ticket.ts"]).toContain("export class TriageTicket");
    expect(body.repo.sha).toBe(journey.repo.sha);
    const first = (await (await call("GET", "/api/stages/ops-triage-ai.m1-01/architecture")).json()) as { nodes: NodeCode[] };
    expect(first.nodes.map((n) => n.nodeId)).toEqual(["text", "classify", "category"]);
  });
});
