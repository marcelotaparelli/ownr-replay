import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resilientSource, testApp } from "./helpers.ts";
import { declarationsOf, type RepositoryIndex } from "../src/services/code-map.ts";
import { discoverFlow, entryShape, findEntryPoints, interfaceImplementations, resolveReceiverType } from "../src/services/flow-discovery.ts";
import { noveltyReport } from "../src/services/curriculum-check.ts";
import { locateTsc, TypeChecker } from "../src/sandbox/typecheck.ts";
import { ModuleGenerationService, StageGenerator, StagePlanner, StageValidator } from "../src/services/stage-generation.ts";
import { TargetedJourneyStore } from "../src/services/targeted-journey.ts";

/**
 * Second repository (marcelotaparelli/resilient-transaction-api, pinned): proves the discovery
 * engine and the generator are not tied to ops-triage-ai. Nothing here is a per-repository recipe:
 * the goals are plain sentences and every chain is asserted against literal lines of the pinned source.
 */
const checker = new TypeChecker(await locateTsc());
const source = resilientSource();
const { index } = source;
const PERSISTENCE_GOAL = "Quero entender como uma transação é persistida no banco de dados.";
const AUTH_GOAL = "Quero entender como funciona a autenticação das requisições";
const label = (s: { container: string | null; symbol: string }): string => (s.container ? `${s.container}.${s.symbol}` : s.symbol);
const generation = (root: string) => new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));

test("o snapshot fixa o SHA e indexa só o código-fonte do repositório", () => {
  expect(source.base.repo).toEqual({ owner: "marcelotaparelli", name: "resilient-transaction-api", url: "https://github.com/marcelotaparelli/resilient-transaction-api", sha: "fe4743b109a1b06c91facc4b34ca5db0c3009b0d" });
  expect(source.base.stages).toEqual([]);
  expect([...index.files.keys()].every((path) => path.startsWith("src/"))).toBe(true);
});

test("reconhece a fábrica de handler como ponto de entrada HTTP", () => {
  const entries = findEntryPoints(index);
  expect(entries.map((entry) => `${entry.path}#${entry.symbol}`)).toEqual(["src/http/server.ts#createHttpHandler"]);
  expect(entryShape(index, entries[0]!)).toBe("handler-factory");
});

test("resolve tipos declarados através de Pick<> e de propriedade injetada na primeira linha do construtor", () => {
  const routeRequest = index.declarations.find((d) => d.symbol === "routeRequest" && d.container === null)!;
  expect(resolveReceiverType(index, routeRequest, ["dependencies", "createTransaction"])).toBe("CreateTransaction");
  const execute = index.declarations.find((d) => d.symbol === "execute" && d.container === "CreateTransaction")!;
  expect(resolveReceiverType(index, execute, ["this", "transactionRepository"])).toBe("TransactionRepository");
});

test("descobre a cadeia de autenticação até a única implementação real, sem receita", () => {
  const flow = discoverFlow(AUTH_GOAL, index, "trace_request");
  expect(flow.chain.map(label)).toEqual(["createHttpHandler", "routeRequest", "authenticate", "ServiceAuthenticator.authenticate", "Sha256ServiceAuthenticator.authenticate"]);
  expect(flow.edges.map((edge) => edge.kind)).toEqual(["call", "call", "call", "implements"]);
  expect(interfaceImplementations(index, flow.chain[3]!)).toEqual(["Sha256ServiceAuthenticator"]);
});

test("descobre o fluxo de persistência e para no contrato quando a implementação não é comprovável", () => {
  const flow = discoverFlow(PERSISTENCE_GOAL, index, "trace_request");
  expect(flow.chain.map(label)).toEqual(["createHttpHandler", "routeRequest", "CreateTransaction.execute", "TransactionRepository.completeIdempotencyOperation"]);
  // Every edge is a literal line of the pinned source, not an inference.
  for (const edge of flow.edges) expect(index.files.get(edge.from.path)?.split("\n")[edge.line - 1]?.trim()).toBe(edge.snippet);
  // Two classes implement the contract: the chain must not pick one.
  expect(interfaceImplementations(index, flow.target)?.sort()).toEqual(["InMemoryTransactionRepository", "PostgresTransactionRepository"]);
  expect(flow.chain.some((node) => node.container?.includes("Postgres") || node.container?.includes("InMemory"))).toBe(false);
});

test("objetivo sem símbolo relevante não inventa fluxo no segundo repositório", () => {
  expect(() => discoverFlow("Quero entender como funciona o blockchain deste projeto.", index, "trace_request")).toThrow();
});

test("uma chamada de membro (Response.json) não vira aresta para uma função de topo com o mesmo nome", () => {
  const path = "src/handler.ts";
  const content = [
    "export type Handler = (request: Request) => Promise<Response>;",
    "export function createHandler(): Handler {",
    "  return async (request: Request): Promise<Response> => {",
    "    return Response.json({ ok: true });",
    "  };",
    "}",
    "function json(body: unknown): Response {",
    "  return new Response(JSON.stringify(body));",
    "}",
    "",
  ].join("\n");
  const mini: RepositoryIndex = { files: new Map([[path, content]]), declarations: declarationsOf(path, content) };
  expect(findEntryPoints(mini).map((entry) => entry.symbol)).toEqual(["createHandler"]);
  expect(() => discoverFlow("Quero entender como funciona o json", mini, "trace_request")).toThrow();
});

test("gera e valida uma jornada de persistência no segundo repositório, com o limite da análise explícito", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-second-repo-"));
  const service = generation(root);
  const route = await service.generateRequestJourney(source.base, PERSISTENCE_GOAL, index, "trace_request");
  const stages = route.stages;

  expect(route.repo.sha).toBe(source.base.repo.sha);
  expect(route.goal).toEqual({ kind: "trace_request", target: PERSISTENCE_GOAL });
  expect(route.description).toContain("TransactionRepository.completeIdempotencyOperation");
  expect(route.description).not.toContain("decisão");
  expect(stages).toHaveLength(4);
  expect(stages.slice(0, -1).every((stage) => stage.kind === "micro")).toBe(true);
  expect(stages.at(-1)?.kind).toBe("checkpoint");
  expect(stages.at(-1)?.exercise?.starterFiles.every((file) => file.content === "")).toBe(true);

  // Contexto → problema → solução mínima, one step at a time, on the learner's own cumulative code.
  expect(stages[0]?.context).toContain("reproduz a fábrica e o handler");
  expect(stages.every((stage) => stage.context && stage.problem)).toBe(true);
  expect(noveltyReport(stages).every((row) => row.newLines <= 5 || row.exception !== undefined)).toBe(true);

  // Every real-code reference is an exact, verifiable slice of the pinned SHA.
  const refs = stages.flatMap((stage) => stage.originalCodeRefs);
  expect(refs.map((ref) => ref.symbol)).toContain("completeIdempotencyOperation");
  for (const ref of refs) {
    expect(ref.url).toContain(source.base.repo.sha);
    expect(index.files.get(ref.path)?.split("\n").slice(ref.startLine - 1, ref.endLine).join("\n")).toBe(ref.snippet);
  }

  const answer = stages.at(-1)?.checkpoint?.answer ?? "";
  expect(answer).toContain("2 implementações (");
  expect(answer).toContain("PostgresTransactionRepository");
  expect(answer).toContain("InMemoryTransactionRepository");
  expect(answer).toContain("análise estática não decide");

  const store = new TargetedJourneyStore(root);
  store.saveRoute(source.base, route);
  expect(store.restore([source.base]).map((restored) => restored.id)).toEqual([route.id]);
});

test("gera a jornada de autenticação (interface com uma única implementação) no segundo repositório", async () => {
  const route = await generation(mkdtempSync(join(tmpdir(), "replay-second-repo-auth-"))).generateRequestJourney(source.base, AUTH_GOAL, index, "trace_request");
  // routeRequest -> authenticate -> contract -> its one implementation, then the checkpoint.
  expect(route.stages.map((stage) => stage.title)).toEqual(["Encaminhar para routeRequest", "Encaminhar para authenticate", "Depender do contrato ServiceAuthenticator", "Implementar ServiceAuthenticator em Sha256ServiceAuthenticator", "Checkpoint: reconstrua a cadeia descoberta"]);
  expect(route.stages.flatMap((stage) => stage.originalCodeRefs).some((ref) => ref.symbol === "authenticate" && ref.path === "src/http/security/service-authenticator.ts")).toBe(true);
  expect(route.stages.at(-1)?.checkpoint?.answer).toContain("Sha256ServiceAuthenticator.authenticate");
});

test("API: pedido de fluxo abre o percurso descoberto no segundo repositório", async () => {
  const app = testApp({ generation: generation(mkdtempSync(join(tmpdir(), "replay-second-repo-api-"))), typeChecker: checker, sources: [source] });
  const repoUrl = "https://github.com/marcelotaparelli/resilient-transaction-api";

  const traced = await app.call("POST", "/api/journeys", { repoUrl, goal: { kind: "trace_request", target: PERSISTENCE_GOAL } });
  expect(traced.status).toBe(200);
  const { id, startOrder } = await traced.json();
  expect(startOrder).toBe(1);
  const outline = await (await app.call("GET", `/api/journeys/${id}`)).json();
  expect(outline.repo.sha).toBe(source.base.repo.sha);
  expect(outline.stages).toHaveLength(4);
  const first = await (await app.call("GET", `/api/stages/${outline.stages[0].id}`)).json();
  expect(first.originalCodeRefs[0].path).toBe("src/http/server.ts");
  const architecture = await (await app.call("GET", `/api/stages/${outline.stages[1].id}/architecture`)).json();
  expect(architecture.nodes.every((node: { status: string }) => node.status === "mapped")).toBe(true);

  // The same goal and intent are served from the generated route; free text typed as "other" is a
  // different intent, so it is a different journey (see flow-intent.test.ts).
  const again = await (await app.call("POST", "/api/journeys", { repoUrl, goal: { kind: "trace_request", target: PERSISTENCE_GOAL } })).json();
  expect(again.id).toBe(id);
  const other = await app.call("POST", "/api/journeys", { repoUrl, goal: { kind: "other", note: AUTH_GOAL } });
  expect(other.status).toBe(200);

  // Honest failure: no invented flow, and no fallback to a journey a learner cannot open.
  const unknown = await app.call("POST", "/api/journeys", { repoUrl, goal: { kind: "trace_request", target: "Quero entender como funciona o blockchain deste projeto." } });
  expect(unknown.status).toBe(422);
  const failure = await unknown.json();
  expect(failure.error.code).toBe("GENERATION_FAILED");
  expect(failure.fallback).toBeUndefined();

  const unsupported = await app.call("POST", "/api/journeys", { repoUrl, goal: { kind: "specific_part", target: "CreateTransaction" } });
  expect(unsupported.status).toBe(501);
  expect((await unsupported.json()).error.code).toBe("GOAL_NOT_AVAILABLE");
  app.repository.close();
});
