import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resilientSource, testApp } from "./helpers.ts";
import { declarationsOf, type RepositoryIndex } from "../src/services/code-map.ts";
import { discoverFlow, findEntryPoints, type CodeSymbol } from "../src/services/flow-discovery.ts";
import { noveltyReport } from "../src/services/curriculum-check.ts";
import { locateTsc, TypeChecker } from "../src/sandbox/typecheck.ts";
import { ModuleGenerationService, StageGenerator, StagePlanner, StageValidator } from "../src/services/stage-generation.ts";

/**
 * The learner's intent (goal.kind) shapes the plan: a traced request starts at a real HTTP entry
 * and fails without one; a free technical goal starts at the outermost symbol related to it and
 * never forces HTTP. Same engine, same evidence rules — different start, scoring pool and narrative.
 */
const checker = new TypeChecker(await locateTsc());
const source = resilientSource();
const { index } = source;
const GOAL = "Quero entender como uma transação é persistida no banco de dados.";
const label = (s: CodeSymbol): string => (s.container ? `${s.container}.${s.symbol}` : s.symbol);
const mini = (files: Record<string, string>): RepositoryIndex => ({ files: new Map(Object.entries(files)), declarations: Object.entries(files).flatMap(([path, content]) => declarationsOf(path, content)) });
const generation = (root = mkdtempSync(join(tmpdir(), "replay-intent-"))) => new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));

test("trace_request exige e começa numa entrada HTTP real; other não força HTTP", () => {
  const traced = discoverFlow(GOAL, index, "trace_request");
  const free = discoverFlow(GOAL, index, "other");
  const entries = findEntryPoints(index).map(label);

  expect(traced.intent).toBe("trace_request");
  expect(entries).toContain(label(traced.chain[0]!));
  expect(traced.chain.map(label)).toEqual(["createHttpHandler", "routeRequest", "CreateTransaction.execute", "TransactionRepository.completeIdempotencyOperation"]);

  expect(free.intent).toBe("other");
  expect(free.chain.some((node) => entries.includes(label(node)))).toBe(false);
  expect(free.chain.map(label)).toEqual(["CreateTransaction.execute", "TransactionRepository.completeIdempotencyOperation"]);
});

test("other começa no símbolo mais externo ligado ao objetivo: a camada HTTP não o alcança por relação com o objetivo", () => {
  const free = discoverFlow(GOAL, index, "other");
  // The trace's extra hops (createHttpHandler, routeRequest) are not about persistence: they carry at most
  // the glossary's generic verb, so they are neither a start nor evidence for one.
  expect(free.chain[0]).toMatchObject({ container: "CreateTransaction", symbol: "execute" });
  // ...and what remains is a suffix of the traced chain: shared evidence, different beginning.
  const traced = discoverFlow(GOAL, index, "trace_request");
  expect(traced.chain.map(label).join(">")).toContain(free.chain.map(label).join(">"));
});

test("os planos diferem quando a intenção exige trajetórias diferentes", () => {
  const planner = new StagePlanner();
  const traced = planner.planRequest(GOAL, source.base, index, "trace_request");
  const free = planner.planRequest(GOAL, source.base, index, "other");
  if (traced.kind !== "discovered-flow" || free.kind !== "discovered-flow") throw new Error("plano inesperado");
  expect([traced.intent, free.intent]).toEqual(["trace_request", "other"]);
  expect(traced.chain.length).toBeGreaterThan(free.chain.length);
  expect(label(traced.chain[0]!)).not.toBe(label(free.chain[0]!));
});

test("jornadas geradas: identidades, objetivos, narrativas e primeiros passos distintos, ambas válidas", async () => {
  const service = generation();
  const traced = await service.generateRequestJourney(source.base, GOAL, index, "trace_request");
  const free = await service.generateRequestJourney(source.base, GOAL, index, "other");

  expect(traced.id).not.toBe(free.id);
  expect(traced.goal).toEqual({ kind: "trace_request", target: GOAL });
  expect(free.goal).toEqual({ kind: "other", note: GOAL });
  expect(traced.stages.map((s) => s.title)).not.toEqual(free.stages.map((s) => s.title));

  expect(traced.stages[0]?.context).toContain("handler HTTP");
  expect(free.stages[0]?.context).not.toContain("HTTP");
  expect(free.stages[0]?.context).toContain("símbolo mais externo ligado ao objetivo");
  expect(free.description).toContain("De CreateTransaction.execute");
  expect(traced.description).toContain("Da entrada HTTP");

  for (const route of [traced, free]) {
    expect(route.stages.at(-1)?.kind).toBe("checkpoint");
    expect(route.stages.at(-1)?.exercise?.starterFiles.every((f) => f.content === "")).toBe(true);
    for (const ref of route.stages.flatMap((s) => s.originalCodeRefs)) {
      expect(index.files.get(ref.path)?.split("\n").slice(ref.startLine - 1, ref.endLine).join("\n")).toBe(ref.snippet);
      expect(ref.url).toContain(source.base.repo.sha);
    }
    expect(route.stages.at(-1)?.checkpoint?.answer).toContain("análise estática não decide");
  }
  // A method as the start needs one justified stage at most; every other stage stays inside the budget.
  expect(noveltyReport(free.stages).filter((row) => row.newLines > 5).every((row) => row.exception !== undefined && row.newLines < 8)).toBe(true);
});

test("sem entrada HTTP comprovada, trace_request falha honestamente e other ensina o conceito", async () => {
  const goal = "Quero entender como funciona o disjuntor de circuito";
  expect(() => discoverFlow(goal, index, "trace_request")).toThrow("nenhum ponto de entrada HTTP alcança");
  const free = discoverFlow(goal, index, "other");
  expect(free.chain[0]?.path).toBe("src/infrastructure/providers/circuit-breaker.ts");
  await expect(generation().generateRequestJourney(source.base, goal, index, "trace_request")).rejects.toThrow();
  const route = await generation().generateRequestJourney(source.base, goal, index, "other");
  expect(route.stages.at(-1)?.kind).toBe("checkpoint");
});

test("num repositório sem nenhum handler HTTP, trace_request falha e other continua possível", () => {
  const noHttp = mini({
    "src/orders.ts": [
      "export async function placeOrder(input: string): Promise<string> {",
      "  return persistOrder(input);",
      "}",
      "export function persistOrder(input: string): string {",
      "  return input;",
      "}",
      "",
    ].join("\n"),
  });
  expect(() => discoverFlow("Quero entender order", noHttp, "trace_request")).toThrow("Nenhum ponto de entrada HTTP");
  expect(discoverFlow("Quero entender order", noHttp, "other").chain.map(label)).toEqual(["placeOrder", "persistOrder"]);
});

test("as intenções convergem só quando a estrutura obriga: o símbolo mais externo ligado ao objetivo é a própria entrada HTTP", () => {
  const http = mini({
    "src/orders.ts": [
      "export async function handleOrder(request: Request): Promise<Response> {",
      "  return new Response(await placeOrder(request.url));",
      "}",
      "async function placeOrder(input: string): Promise<string> {",
      "  return persistOrder(input);",
      "}",
      "function persistOrder(input: string): string {",
      "  return input;",
      "}",
      "",
    ].join("\n"),
  });
  const traced = discoverFlow("Quero entender order", http, "trace_request");
  const free = discoverFlow("Quero entender order", http, "other");
  expect(traced.chain.map(label)).toEqual(["handleOrder", "placeOrder", "persistOrder"]);
  expect(free.chain.map(label)).toEqual(traced.chain.map(label));
  // The intents are still not interchangeable: they carry different meaning even when the chain agrees.
  expect([traced.intent, free.intent]).toEqual(["trace_request", "other"]);
});

test("objetivo sem correspondência suficiente falha nas duas intenções", () => {
  for (const intent of ["trace_request", "other"] as const) {
    expect(() => discoverFlow("Quero entender como funciona o blockchain deste projeto.", index, intent)).toThrow("corresponde");
  }
});

test("API: o mesmo texto pedido como trace_request e como other gera jornadas distintas e reaproveitáveis", async () => {
  const app = testApp({ generation: generation(), typeChecker: checker, sources: [source] });
  const repoUrl = "https://github.com/marcelotaparelli/resilient-transaction-api";
  const ask = async (goal: unknown) => (await (await app.call("POST", "/api/journeys", { repoUrl, goal })).json()) as { id: string; startOrder?: number };

  const traced = await ask({ kind: "trace_request", target: GOAL });
  const free = await ask({ kind: "other", note: GOAL });
  expect(traced.id).not.toBe(free.id);
  expect(free.startOrder).toBe(1);

  const outline = async (id: string) => (await (await app.call("GET", `/api/journeys/${id}`)).json()) as { goal: unknown; stages: { id: string }[] };
  expect((await outline(traced.id)).goal).toEqual({ kind: "trace_request", target: GOAL });
  expect((await outline(free.id)).goal).toEqual({ kind: "other", note: GOAL });
  expect((await outline(free.id)).stages.length).toBeLessThan((await outline(traced.id)).stages.length);

  // Asking again with the same intent reuses the journey; the other intent is never confused with it.
  expect((await ask({ kind: "trace_request", target: GOAL })).id).toBe(traced.id);
  expect((await ask({ kind: "other", note: GOAL })).id).toBe(free.id);
  app.repository.close();
});
