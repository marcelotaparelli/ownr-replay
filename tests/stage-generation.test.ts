import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { golden, testApp } from "./helpers.ts";
import { indexRepository, originalDir } from "../src/services/code-map.ts";
import { TypeChecker, locateTsc } from "../src/sandbox/typecheck.ts";
import { ModuleGenerationService, StageGenerator, StagePlanner, StageValidator } from "../src/services/stage-generation.ts";
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

test("objetivo específico solicitado pela home publica Module 2 sem editar journey.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "replay-goal-generation-"));
  const service = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const app = testApp({ generation: service, typeChecker: checker });
  const response = await app.call("POST", "/api/journeys", { repoUrl: "https://github.com/marcelotaparelli/ops-triage-ai", goal: { kind: "specific_part", target: "TriageClassifier" } });
  expect(response.status).toBe(200);
  expect((await response.json()).id).toBe("ops-triage-ai");
  const journey = await (await app.call("GET", "/api/journeys/ops-triage-ai")).json();
  expect(journey.modules.find((m: { id: string }) => m.id === "m2").stageIds.length).toBe(8);
  app.repository.close();
});
