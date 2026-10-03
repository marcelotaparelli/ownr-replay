import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { golden, testApp } from "./helpers.ts";
import { indexRepository, originalDir } from "../src/services/code-map.ts";
import { TypeChecker, locateTsc } from "../src/sandbox/typecheck.ts";
import { ModuleGenerationService, StageGenerator, StagePlanner, StageValidator } from "../src/services/stage-generation.ts";
import { TargetedJourneyStore } from "../src/services/targeted-journey.ts";
import { noveltyReport } from "../src/services/curriculum-check.ts";
import { stageCodeHighlights } from "../src/domain/line-diff.ts";

const checker = new TypeChecker(await locateTsc());
const index = indexRepository(originalDir(join(import.meta.dir, "../data/golden/ops-triage-ai")));

test("pedido do Module 2 gera e persiste somente após validação", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-generation-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const journey = golden();
  const generated = await service.generate(journey, "m2", "Aprender Module 2 e TriageClassifier", index);
  const stages = generated.stages.filter((s) => s.moduleId === "m2");
  expect(stages.length).toBeGreaterThan(2);
  expect(stages.at(-1)?.kind).toBe("checkpoint");
  expect(stages.at(-1)?.exercise?.starterFiles[0]?.content).toBe("");
  expect(stages.slice(0, -1).every((s) => s.kind === "micro")).toBe(true);
  expect(noveltyReport(stages).every((row) => row.newLines <= 5)).toBe(true);
  expect(stages.slice(1, -1).every((s) => (stageCodeHighlights(generated.stages, s.id)["port.ts"]?.length ?? 0) > 0)).toBe(true);
  expect(stages.slice(0, -1).every((s, i) => s.context?.includes(i === 0 ? "módulo anterior" : "etapa anterior") && s.problem.includes("Nesta etapa,") && (s.explanation[0]?.quick.length ?? 0) > 60)).toBe(true);
  expect(stages[0]?.explanation[0]?.quick).toContain("classify(input)");
  expect(stages.every((s) => s.lineNotes.every((note) => s.referenceCode[0]?.content.includes(note.match)))).toBe(true);
  expect(generated.modules.find((m) => m.id === "m3")?.stageIds).toEqual(journey.modules.find((m) => m.id === "m3")?.stageIds);
  expect(service.restore(journey).modules.find((m) => m.id === "m2")?.stageIds).toEqual(stages.map((s) => s.id));
  expect(JSON.parse(readFileSync(service.path(journey.id, "m2"), "utf8")).sha).toBe(journey.repo.sha);
});

test("resultado estruturado gera Module 3 do SHA fixado e preserva Module 2", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-decision-generation-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const journey = golden();
  const withM2 = await service.generate(journey, "m2", "Aprender Module 2 e TriageClassifier", index);
  const generated = await service.generate(withM2, "m3", "Aprender Module 3: decisão estruturada", index);
  const stages = generated.stages.filter((stage) => stage.moduleId === "m3");
  expect(stages.length).toBe(9);
  expect(stages.at(-1)?.kind).toBe("checkpoint");
  expect(stages.at(-1)?.exercise?.starterFiles[0]?.content).toBe("");
  expect(noveltyReport(stages).every((row) => row.newLines <= 4)).toBe(true);
  expect(stages.slice(1, -1).every((stage) => (stageCodeHighlights(generated.stages, stage.id)["decision.ts"]?.length ?? 0) > 0)).toBe(true);
  expect(stages.slice(0, -1).every((stage, i) => stage.context?.includes(i === 0 ? "Até aqui" : "etapa anterior") && stage.problem.includes("Nesta etapa,") && (stage.explanation[0]?.quick.length ?? 0) > 60)).toBe(true);
  expect(stages.every((s) => s.lineNotes.every((note) => s.referenceCode[0]?.content.includes(note.match)))).toBe(true);
  expect(stages.every((stage) => stage.originalCodeRefs.every((ref) => ref.url.includes(journey.repo.sha)))).toBe(true);
  expect(generated.modules.find((module) => module.id === "m2")?.stageIds).toEqual(withM2.modules.find((module) => module.id === "m2")?.stageIds);
  expect(service.restore(journey).modules.find((module) => module.id === "m3")?.stageIds).toEqual(stages.map((stage) => stage.id));
});

test("falha de validação deixa capítulo legado e arquivo persistido intactos", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-generation-failure-"));
  const generator = new StageGenerator();
  const provider = { generate: (plan: Parameters<StageGenerator["generate"]>[0], journey: Parameters<StageGenerator["generate"]>[1], repo: Parameters<StageGenerator["generate"]>[2]) => {
    const stages = generator.generate(plan, journey, repo);
    const first = stages[0]!;
    return [{ ...first, originalCodeRefs: [{ ...first.originalCodeRefs[0]!, snippet: "inventado" }] }, ...stages.slice(1)];
  } };
  const service = new ModuleGenerationService(root, new StagePlanner(), provider, new StageValidator(checker));
  const journey = golden();
  await expect(service.generate(journey, "m2", "Aprender Module 2", index)).rejects.toThrow("referência real inválida");
  expect(service.restore(journey).modules.find((m) => m.id === "m2")?.stageIds).toEqual(["ops-triage-ai.02"]);
});

test("Module 3 inválido mantém o capítulo legado", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-decision-failure-"));
  const generator = new StageGenerator();
  const provider = { generate: (plan: Parameters<StageGenerator["generate"]>[0], journey: Parameters<StageGenerator["generate"]>[1], repo: Parameters<StageGenerator["generate"]>[2]) => {
    const stages = generator.generate(plan, journey, repo);
    return stages.map((stage, index) => index === 0 ? { ...stage, originalCodeRefs: [{ ...stage.originalCodeRefs[0]!, snippet: "inventado" }] } : stage);
  } };
  const service = new ModuleGenerationService(root, new StagePlanner(), provider, new StageValidator(checker));
  const journey = golden();
  await expect(service.generate(journey, "m3", "Aprender decisão estruturada", index)).rejects.toThrow("referência real inválida");
  expect(service.restore(journey).modules.find((module) => module.id === "m3")?.stageIds).toEqual(["ops-triage-ai.03"]);
});

test("ação do capítulo gera Module 3 pela API", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-decision-api-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const app = testApp({ generation: service, typeChecker: checker });
  const response = await app.call("POST", "/api/journeys/ops-triage-ai/modules/m3/generate", { goal: "Aprender Decisão estruturada e entender TriageClassifier" });
  expect(response.status).toBe(200);
  const outline = await response.json();
  expect(outline.modules.find((module: { id: string }) => module.id === "m3").stageIds.length).toBe(9);
  expect(outline.modules.find((module: { id: string }) => module.id === "m2").stageIds).toEqual(["ops-triage-ai.02"]);
  app.repository.close();
});

test("objetivo específico solicitado pela home publica Module 2 sem editar journey.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-goal-generation-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const app = testApp({ generation: service, typeChecker: checker });
  const response = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "specific_part", target: "TriageClassifier" } });
  expect(response.status).toBe(200);
  const requested = await response.json();
  expect(requested.id.startsWith("ops-triage-ai--triageclassifier-")).toBe(true);
  const scoped = await (await app.call("GET", `/api/journeys/${requested.id}`)).json();
  expect(scoped.modules).toHaveLength(1);
  expect(scoped.goal).toEqual({ kind: "specific_part", target: "TriageClassifier" });
  const journey = await (await app.call("GET", "/api/journeys/ops-triage-ai")).json();
  expect(journey.modules.find((m: { id: string }) => m.id === "m2").stageIds.length).toBe(8);
  app.repository.close();
});

test("solicitação específica do adapter remoto gera Module 4 e abre sua primeira etapa", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-remote-generation-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const app = testApp({ generation: service, typeChecker: checker });
  const response = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "specific_part", target: "OllamaTriageClassifier" } });
  expect(response.status).toBe(200);
  const requested = await response.json();
  const journey = await (await app.call("GET", "/api/journeys/ops-triage-ai")).json();
  const stages = journey.stages.filter((stage: { moduleId: string }) => stage.moduleId === "m4");
  expect(requested.id.startsWith("ops-triage-ai--ollamatriageclassifier-")).toBe(true);
  expect(requested.startOrder).toBe(1);
  expect(stages).toHaveLength(11);
  expect(stages.at(-1)?.kind).toBe("checkpoint");
  const scoped = await (await app.call("GET", `/api/journeys/${requested.id}`)).json();
  expect(scoped.modules).toHaveLength(1);
  expect(scoped.stages).toHaveLength(11);
  const first = await (await app.call("GET", `/api/stages/${scoped.stages[0].id}`)).json();
  expect(first.originalCodeRefs[0].url).toContain(journey.repo.sha);
  expect(service.restore(golden()).modules.find((module) => module.id === "m4")?.stageIds).toEqual(stages.map((stage: { id: string }) => stage.id));
  app.repository.close();
});

test("estrutura não suportada mantém capítulo e comunica a limitação", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-unsupported-generation-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const app = testApp({ generation: service, typeChecker: checker });
  const response = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "specific_part", target: "PersistedTriageService" } });
  expect(response.status).toBeGreaterThanOrEqual(400);
  const journey = await (await app.call("GET", "/api/journeys/ops-triage-ai")).json();
  expect(journey.modules.find((module: { id: string }) => module.id === "m6").stageIds).toEqual(["ops-triage-ai.06"]);
  app.repository.close();
});

test("jornada específica restaurada conserva objetivo e etapas próprias", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-target-restore-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const generated = await service.generate(golden(), "m4", "OllamaTriageClassifier", index);
  const store = new TargetedJourneyStore(root);
  const saved = store.save(generated, "m4", "OllamaTriageClassifier");
  const restored = store.restore([service.restore(golden())]);
  expect(restored).toHaveLength(1);
  expect(restored[0]?.id).toBe(saved.id);
  expect(restored[0]?.goal).toEqual({ kind: "specific_part", target: "OllamaTriageClassifier" });
  expect(restored[0]?.stages[0]?.order).toBe(1);
  expect(restored[0]?.stages.at(-1)?.kind).toBe("checkpoint");
});

test("objetivo técnico gera fluxo HTTP até decisão persistida com referências verificáveis", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-flow-generation-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const store = new TargetedJourneyStore(root);
  const goal = "Quero compreender o fluxo completo de um ticket no ops-triage-ai, desde a entrada HTTP até a decisão e a persistência.";
  const route = await service.generateRequestJourney(golden(), goal, index, "trace_request");
  const stages = route.stages;
  expect(route.goal).toEqual({ kind: "trace_request", target: goal });
  expect(stages).toHaveLength(8);
  expect(stages.slice(0, -1).every((stage) => stage.kind === "micro" && stage.introduces.length <= 1)).toBe(true);
  expect(stages.at(-1)?.kind).toBe("checkpoint");
  expect(stages.at(-1)?.checkpoint?.answer).toContain("PrismaTriageRunRepository");
  expect(stages.flatMap((stage) => stage.originalCodeRefs).every((ref) => ref.url.includes(golden().repo.sha) && index.files.get(ref.path)?.includes(ref.snippet))).toBe(true);
  expect(noveltyReport(stages).every((row) => row.newLines <= 5)).toBe(true);
  store.saveRoute(golden(), route);
  expect(store.restore([golden()])[0]?.id).toBe(route.id);
});

test("pedido pela API abre a jornada do fluxo e sua primeira microetapa", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-flow-api-"));
  const app = testApp({ generation: new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker)), typeChecker: checker });
  const goal = "Quero compreender o fluxo completo de um ticket no ops-triage-ai, desde a entrada HTTP até a decisão e a persistência.";
  const response = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "trace_request", target: goal } });
  expect(response.status).toBe(200);
  const requested = await response.json();
  expect(requested.startOrder).toBe(1);
  const outline = await (await app.call("GET", `/api/journeys/${requested.id}`)).json();
  expect(outline.modules).toHaveLength(1);
  expect(outline.stages).toHaveLength(8);
  const first = await (await app.call("GET", `/api/stages/${outline.stages[0].id}`)).json();
  expect(first.title).toBe("Validar a entrada");
  expect(first.originalCodeRefs[0].path).toBe("src/http/triage-request.ts");
  app.repository.close();
});

test("rota HTTP sem percurso comprovado no gerador do ticket informa a limitação", async () => {
  const service = new ModuleGenerationService(mkdtempSync(join(tmpdir(), "replay-other-route-")), new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  // "ticket" keeps this goal routed to the hand-authored ticket-flow trace (looksLikeTicketFlowGoal),
  // which only ever proved one route; anything else it should still refuse instead of guessing.
  await expect(service.generateRequestJourney(golden(), "GET /ticket/123", index, "trace_request")).rejects.toThrow("ainda não tem um percurso validado");
});

test("rota antes sem percurso comprovado agora é descoberta genericamente (GET /triage/:id)", async () => {
  // "GET /triage/123" no longer contains the word "ticket", so it reaches generic discovery
  // instead of the hand-authored ticket trace — and discovery finds the real handler for this
  // route (PersistedTriageService.getDecisionAudit), which the old hardcoded generator never knew.
  const service = new ModuleGenerationService(mkdtempSync(join(tmpdir(), "replay-generic-route-")), new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const route = await service.generateRequestJourney(golden(), "GET /triage/123", index, "trace_request");
  expect(route.stages.flatMap((stage) => stage.originalCodeRefs).some((ref) => ref.symbol === "getDecisionAudit")).toBe(true);
});

test("planejador aceita outra formulação do mesmo objetivo técnico", () => {
  const plan = new StagePlanner().planRequest("Como POST /tickets/triage chega à decisão persistida?", golden(), index, "trace_request");
  if (plan.kind !== "request-trace") throw new Error("expected a request-trace plan");
  expect(plan.steps.map((step) => step.symbol)).toEqual([
    "parseTicketInput", "PersistedTriageService", "PrismaTriageRunRepository", "TriageTicket",
    "HybridPolicy", "PrismaTriageRunRepository", "handleRequest",
  ]);
});

test("objetivo do fluxo descrito como 'outro' pela home ainda abre a jornada do fluxo", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-flow-other-"));
  const app = testApp({ generation: new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker)), typeChecker: checker });
  const goal = "Quero compreender o fluxo completo de um ticket no ops-triage-ai, desde a entrada HTTP até a decisão e a persistência.";
  const response = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "other", note: goal } });
  expect(response.status).toBe(200);
  const requested = await response.json();
  expect(requested.startOrder).toBe(1);
  const outline = await (await app.call("GET", `/api/journeys/${requested.id}`)).json();
  expect(outline.goal).toEqual({ kind: "trace_request", target: goal });
  expect(outline.stages).toHaveLength(8);
  // Repeating the same objective — as trace_request or again as "other" — reuses the saved journey.
  const repeatAsTrace = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "trace_request", target: goal } });
  expect((await repeatAsTrace.json()).id).toBe(requested.id);
  const repeatAsOther = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "other", note: goal } });
  expect((await repeatAsOther.json()).id).toBe(requested.id);
  app.repository.close();
});

test("objetivo 'outro' não relacionado ao fluxo mantém o fallback atual", async () => {
  const app = testApp({});
  const response = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "other", note: "Quero entender como o projeto lida com autenticação." } });
  expect(response.status).toBe(501);
  const body = await response.json();
  expect(body.error.code).toBe("GOAL_NOT_AVAILABLE");
  expect(body.fallback.id).toBe("ops-triage-ai");
  app.repository.close();
});
