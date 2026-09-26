import { expect, test } from "bun:test";
import type { Journey } from "../src/domain/journey.ts";
import type { Stage } from "../src/domain/stage.ts";
import { systemPrompt, tutorContext } from "../src/services/tutor-context.ts";
import { offlineAnswer } from "../src/services/tutor-offline.ts";
import { golden } from "./helpers.ts";

const journey = golden();
const stage1: Stage = requireStage(journey.stages[0]);

function requireStage(stage: Stage | undefined): Stage {
  if (!stage) throw new Error("stage 1 missing");
  return stage;
}

/** A copy of the journey with a fake later stage, to prove it never leaks. */
function withFutureStage(): Journey {
  const future: Stage = { ...stage1, id: "ops-triage-ai.99", order: 99, title: "FUTURE_STAGE_TITLE", introduces: ["hybrid-policy"], summary: { ...stage1.summary, why: "FUTURE_WHY" } };
  return { ...journey, stages: [...journey.stages, future] };
}

test("tutor context never includes later stages", () => {
  const extended = withFutureStage();
  const context = tutorContext(extended, stage1);
  const prompt = systemPrompt(context);
  expect(prompt).not.toContain("FUTURE_STAGE_TITLE");
  expect(prompt).not.toContain("FUTURE_WHY");
  expect(context.knownSoFar.map((c) => c.id)).not.toContain("hybrid-policy");
  expect(prompt).toContain(stage1.title);
});

test("offline tutor explains the selected concept with its real-project location", () => {
  const selection = { file: "triage.ts", startLine: 49, endLine: 55, text: "const TIE_BREAK: Category[] = [" };
  const answer = offlineAnswer(tutorContext(journey, stage1, selection), "por que precisamos disso?");
  expect(answer).toContain("Desempate explícito");
  expect(answer).toContain("Sem isso:");
  // Regression: the incidental "Category" type annotation must not win over the concept.
  expect(answer).toContain("CATEGORY_TIE_BREAK");
});

test("offline tutor defers concepts from later stages instead of teaching them early", () => {
  const answer = offlineAnswer(tutorContext(journey, stage1), "como funciona a HybridPolicy?");
  expect(answer).toContain("aparece mais adiante");
  expect(answer).toContain("Stage 05");
});

test("the real journey never leaks later stage titles into an earlier stage prompt", () => {
  for (const stage of journey.stages) {
    const prompt = systemPrompt(tutorContext(journey, stage));
    for (const later of journey.stages.filter((s) => s.order > stage.order)) {
      expect(prompt).not.toContain(later.title);
    }
  }
});

test("offline tutor points to the real project when asked where", () => {
  const answer = offlineAnswer(tutorContext(journey, stage1), "onde isso está no projeto real?");
  expect(answer).toContain("src/application/classifiers/deterministic-triage-classifier.ts");
});

test("offline tutor falls back to the stage focus when nothing matches", () => {
  const answer = offlineAnswer(tutorContext(journey, stage1), "olá");
  expect(answer).toContain(stage1.goal);
});
