import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildAstGraph, FULL_AST, type AstGraph } from "../src/experiments/ast-facts.ts";
import { decide } from "../src/experiments/ast-abstain.ts";
import { chainSignals, type ChainSignals } from "../src/experiments/ast-confidence.ts";

/**
 * The EXPERIMENTAL abstention rule (src/experiments, not product): it accepts or refuses the one chain the AST spike
 * produced and never chooses another. These tests pin the rule's behaviour on signals and on two tiny repositories; they
 * say nothing about how well the rule generalises (that needs a new holdout).
 */

const clean: ChainSignals = {
  hops: 1, implementsEdges: 0, concepts: 2, conceptsCovered: 1, conceptCoverage: 0.5, domainConcepts: 1, domainConceptsCovered: 0, prefixOnlyMatches: 0,
  nodesRelatedShare: 1, entryRelated: true, targetRelated: true, edgesByNameShare: 1, edgesWithoutEvidenceShare: 0, distinctCandidates: 1, tiedWithTop: 1,
  nearTop: 1, marginToNext: 4.5, runnerUpRatio: 0, roots: 1, relevantDeclarations: 3, terminal: "external", terminalOutDegree: 0, terminalForkWidth: 0,
  targetNameFrequency: 1, entryNameFrequency: 1, usesEntryHeuristic: false, aliasEdges: 0,
};

test("abstain: sem cadeia o seletor se abstém", () => {
  expect(decide(null)).toEqual({ verdict: "ABSTAIN", reasons: ["no chain"] });
});

test("abstain: vencedor sem concorrente próximo e com todos os nós relacionados é aceito", () => {
  expect(decide(clean).verdict).toBe("ACCEPT");
  expect(decide({ ...clean, runnerUpRatio: 0.5 }).verdict).toBe("ACCEPT");
});

test("abstain: empate ou quase empate no ranking, ou nó sem conceito do objetivo, recusam — com o motivo", () => {
  expect(decide({ ...clean, runnerUpRatio: 1 })).toEqual({ verdict: "ABSTAIN", reasons: ["a competing chain scores 100% of the winner"] });
  expect(decide({ ...clean, runnerUpRatio: 0.9 }).verdict).toBe("ABSTAIN");
  expect(decide({ ...clean, nodesRelatedShare: 0.5 }).reasons).toEqual(["50% of the chain's nodes carry no concept of the goal"]);
});

const FILES: Record<string, string> = {
  "solo/controller.ts": `
import { PaymentsService } from "./service";
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  create(dto: Dto) { return this.payments.create(dto); }
}
`,
  "solo/service.ts": `export class PaymentsService { create(dto: Dto) { return dto; } }\n`,
  "twin/a.ts": `
import { OrdersService } from "./svc";
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}
  create(dto: Dto) { return this.orders.create(dto); }
}
`,
  "twin/b.ts": `
import { OrdersService } from "./svc";
export class OrdersResolver {
  constructor(private readonly orders: OrdersService) {}
  create(dto: Dto) { return this.orders.create(dto); }
}
`,
  "twin/svc.ts": `export class OrdersService { create(dto: Dto) { return dto; } }\n`,
};
let root = "";
const graphOf = async (dir: string): Promise<AstGraph> => {
  const sub = join(root, dir);
  return buildAstGraph(sub, FULL_AST);
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ast-abstain-"));
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("abstain: cadeia única e relacionada é aceita; duas cadeias equivalentes (controller e resolver) levam à abstenção", async () => {
  const solo = chainSignals("Quero entender como um pagamento é criado.", "other", await graphOf("solo"));
  expect(solo?.runnerUpRatio).toBe(0);
  expect(decide(solo).verdict).toBe("ACCEPT");
  const twin = chainSignals("Quero entender como um pedido é criado.", "other", await graphOf("twin"));
  expect(twin?.runnerUpRatio).toBe(1);
  expect(decide(twin).verdict).toBe("ABSTAIN");
});
