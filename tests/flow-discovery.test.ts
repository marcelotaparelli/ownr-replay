import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { golden, testApp } from "./helpers.ts";
import { indexRepository, originalDir } from "../src/services/code-map.ts";
import { discoverFlow, isInterfaceDeclaration, parameterTypesOf, resolveReceiverType, tokenizeGoal } from "../src/services/flow-discovery.ts";
import { locateTsc, TypeChecker } from "../src/sandbox/typecheck.ts";
import { ModuleGenerationService, StageGenerator, StagePlanner, StageValidator } from "../src/services/stage-generation.ts";
import { TargetedJourneyStore } from "../src/services/targeted-journey.ts";
import { noveltyReport } from "../src/services/curriculum-check.ts";

const checker = new TypeChecker(await locateTsc());
const index = indexRepository(originalDir(join(import.meta.dir, "../data/golden/ops-triage-ai")));
const AUTH_GOAL = "Quero entender como funciona a autenticação das requisições neste projeto.";

test("tokenizeGoal expande o objetivo em português sem inventar palavras não relacionadas", () => {
  const tokens = tokenizeGoal(AUTH_GOAL);
  expect(tokens.has("authorized")).toBe(true);
  expect(tokens.has("unauthorized")).toBe(true);
  expect(tokens.has("password")).toBe(false);
});

test("descobre a cadeia real de autorização por análise estática, sem receita para autenticação", () => {
  const flow = discoverFlow(AUTH_GOAL, index);
  expect(flow.chain.map((symbol) => symbol.symbol)).toEqual(["handleRequest", "routeRequest", "authorized"]);
  expect(flow.entry).toEqual({ path: "src/server.ts", symbol: "handleRequest", container: null, startLine: 29, endLine: 47 });
  expect(flow.target.symbol).toBe("authorized");
  // Every edge is a literal line of the pinned source, not an inference.
  for (const edge of flow.edges) {
    const line = index.files.get(edge.from.path)?.split("\n")[edge.line - 1]?.trim();
    expect(line).toBe(edge.snippet);
  }
});

test("objetivo sem correspondência real no SHA fixado não inventa um fluxo", () => {
  expect(() => discoverFlow("Quero entender como funciona o cache distribuído deste projeto.", index)).toThrow();
});

test("planejador e gerador produzem um percurso verificado para o objetivo de autenticação", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-discovered-flow-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const store = new TargetedJourneyStore(root);
  const route = await service.generateRequestJourney(golden(), AUTH_GOAL, index);
  const stages = route.stages;

  expect(route.goal).toEqual({ kind: "trace_request", target: AUTH_GOAL });
  expect(stages).toHaveLength(3);
  expect(stages[0]?.kind).toBe("micro");
  expect(stages[1]?.kind).toBe("micro");
  expect(stages.at(-1)?.kind).toBe("checkpoint");
  expect(stages.at(-1)?.checkpoint?.answer).toContain("authorized");

  // Every real-code reference is an exact, verifiable slice of the pinned SHA.
  const refs = stages.flatMap((stage) => stage.originalCodeRefs);
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) {
    expect(ref.url).toContain(golden().repo.sha);
    expect(index.files.get(ref.path)?.includes(ref.snippet)).toBe(true);
  }
  expect(refs.some((ref) => ref.symbol === "authorized")).toBe(true);

  expect(noveltyReport(stages).every((row) => row.newLines <= 5)).toBe(true);
  store.saveRoute(golden(), route);
  expect(store.restore([golden()])[0]?.id).toBe(route.id);
});

test("pedido pela API de trace_request abre o percurso de autenticação descoberto", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-discovered-flow-api-"));
  const app = testApp({ generation: new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker)), typeChecker: checker });
  const response = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "trace_request", target: AUTH_GOAL } });
  expect(response.status).toBe(200);
  const requested = await response.json();
  expect(requested.startOrder).toBe(1);
  const outline = await (await app.call("GET", `/api/journeys/${requested.id}`)).json();
  expect(outline.stages).toHaveLength(3);
  const first = await (await app.call("GET", `/api/stages/${outline.stages[0].id}`)).json();
  expect(first.originalCodeRefs[0].path).toBe("src/server.ts");
  app.repository.close();
});

const PERSISTENCE_GOAL = "Quero entender como uma decisão de triagem é persistida no banco de dados.";

test("descoberta persegue a cadeia real até a escrita de fato, através da interface de repositório", () => {
  const flow = discoverFlow(PERSISTENCE_GOAL, index);
  const labels = flow.chain.map((s) => (s.container ? `${s.container}.${s.symbol}` : s.symbol));
  // The chain must not stop at the first relevant hit (PersistedTriageService.execute) — it has
  // to keep following real, resolved calls through the repository's interface, to its one real
  // implementation, down to the function that performs the actual write.
  expect(labels).toEqual([
    "handleRequest", "routeRequest", "PersistedTriageService.execute",
    "TriageRunRepository.complete", "PrismaTriageRunRepository.complete", "createDecision",
  ]);
  // routeRequest -> execute resolves through TriageService, whose own file is not even present
  // in this pinned snapshot (a real, common gap) — proven only because exactly one concrete class
  // implements it ("implements"). execute -> TriageRunRepository.complete is a direct, provable
  // call to an interface method that DOES exist in the index ("call"); THAT interface then
  // resolves, again uniquely, to its one real implementation ("implements").
  expect(flow.edges.map((e) => e.kind)).toEqual(["call", "implements", "call", "implements", "call"]);
});

test("descobre e gera um percurso mais longo (persistência) sem restrição de 3 símbolos", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-persistence-flow-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const store = new TargetedJourneyStore(root);
  const route = await service.generateRequestJourney(golden(), PERSISTENCE_GOAL, index);
  const stages = route.stages;

  expect(route.goal).toEqual({ kind: "trace_request", target: PERSISTENCE_GOAL });
  expect(stages).toHaveLength(5);
  expect(stages.at(-1)?.kind).toBe("checkpoint");
  expect(stages.slice(0, -1).every((s) => s.kind === "micro")).toBe(true);

  const refs = stages.flatMap((stage) => stage.originalCodeRefs);
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) {
    expect(ref.url).toContain(golden().repo.sha);
    expect(index.files.get(ref.path)?.includes(ref.snippet)).toBe(true);
  }
  // Reaches the real storage write (createDecision), not just the orchestrating service method.
  expect(refs.some((ref) => ref.symbol === "createDecision")).toBe(true);
  expect(refs.some((ref) => ref.symbol === "execute")).toBe(true);
  // The interface/implementation distinction is taught explicitly, not silently merged away.
  expect(stages.some((s) => s.context?.includes("injeção de dependência"))).toBe(true);
  expect(stages.at(-1)?.checkpoint?.answer).toContain("injeção de dependência");
  expect(stages.at(-1)?.checkpoint?.answer).toContain("createDecision");

  expect(noveltyReport(stages).every((row) => row.newLines <= 5)).toBe(true);
  store.saveRoute(golden(), route);
  expect(store.restore([golden()])[0]?.id).toBe(route.id);
});

test("jornada de autenticação anterior continua funcionando após a generalização", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-auth-regression-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const route = await service.generateRequestJourney(golden(), AUTH_GOAL, index);
  expect(route.stages.at(-1)?.checkpoint?.answer).toContain("authorized");
  expect(route.stages.some((s) => s.exercise?.supportFiles.some((f) => f.path === "guard.ts"))).toBe(true);
});

test("objetivo sem símbolo relevante explica a limitação em vez de inventar", () => {
  expect(() => new StagePlanner().planRequest("Quero entender como funciona o cache distribuído deste projeto.", golden(), index)).toThrow();
});

test("resolução de tipo declarado: propriedade injetada via construtor e parâmetro de função", () => {
  const routeRequest = index.declarations.find((d) => d.symbol === "routeRequest" && d.container === null)!;
  expect(resolveReceiverType(index, routeRequest, ["dependencies", "triageService"])).toBe("TriageService");
  const execute = index.declarations.find((d) => d.symbol === "execute" && d.container === "PersistedTriageService")!;
  expect(resolveReceiverType(index, execute, ["this", "triageRunRepository"])).toBe("TriageRunRepository");
  expect(resolveReceiverType(index, execute, ["this", "naoExiste"])).toBeNull();
  expect([...parameterTypesOf(index, routeRequest)]).toContainEqual(["dependencies", "ServerDependencies"]);
});

test("distingue interface de implementação concreta", () => {
  expect(isInterfaceDeclaration(index, "src/application/ports/triage-persistence.ts", "TriageRunRepository")).toBe(true);
  expect(isInterfaceDeclaration(index, "src/infrastructure/persistence/prisma-triage-repositories.ts", "PrismaTriageRunRepository")).toBe(false);
});

