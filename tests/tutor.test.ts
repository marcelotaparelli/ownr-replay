import { expect, test } from "bun:test";
import type { Journey } from "../src/domain/journey.ts";
import type { Stage } from "../src/domain/stage.ts";
import { systemPrompt, tutorContext } from "../src/services/tutor-context.ts";
import { offlineAnswer } from "../src/services/tutor-offline.ts";
import { golden } from "./helpers.ts";

const journey = golden();

function stage(id: string): Stage {
  const found = journey.stages.find((s) => s.id === id);
  if (!found) throw new Error(`missing stage ${id}`);
  return found;
}

const first = stage("ops-triage-ai.m1-01");
const tieBreak = stage("ops-triage-ai.m1-11");
const checkpoint = stage("ops-triage-ai.m1-99");

/** A copy of the journey with a fake later stage, to prove it never leaks. */
function withFutureStage(): Journey {
  const future: Stage = { ...first, id: "ops-triage-ai.zz-99", order: 999, title: "FUTURE_STAGE_TITLE", introduces: [], goal: "FUTURE_GOAL" };
  return { ...journey, stages: [...journey.stages, future] };
}

test("tutor context never includes later stages", () => {
  const prompt = systemPrompt(tutorContext(withFutureStage(), first));
  expect(prompt).not.toContain("FUTURE_STAGE_TITLE");
  expect(prompt).not.toContain("FUTURE_GOAL");
  expect(prompt).toContain(first.title);
});

test("the real journey never leaks later stage titles into an earlier stage prompt", () => {
  for (const s of journey.stages) {
    const prompt = systemPrompt(tutorContext(journey, s));
    for (const later of journey.stages.filter((x) => x.order > s.order)) {
      expect(prompt).not.toContain(`"${later.title}"`);
    }
  }
});

test("at the first micro stage the tutor answers at that level, not with architecture", () => {
  const context = tutorContext(journey, first);
  expect(context.knownSoFar.map((c) => c.id)).toEqual(["function-io"]);
  const answer = offlineAnswer(context, "Por que essa função existe?");
  expect(answer).toContain("Função");
  for (const term of ["interface", "injeção", "Inversão", "porta", "HybridPolicy", "LLM"]) expect(answer).not.toContain(term);
  expect(systemPrompt(context)).toContain("Nível do aluno");
});

test("offline tutor defers concepts from later modules instead of teaching them early", () => {
  const answer = offlineAnswer(tutorContext(journey, first), "como funciona a HybridPolicy?");
  expect(answer).toContain("aparece mais adiante");
  expect(answer).toContain("HybridPolicy: um vigia o outro");
});

test("offline tutor explains the selected line with the stage's own concept", () => {
  const selection = { file: "classify.ts", startLine: 2, endLine: 2, text: 'const TIE_BREAK = ["INCIDENT", "ACCESS", "BUG"];' };
  const answer = offlineAnswer(tutorContext(journey, tieBreak, selection), "por que precisamos disso?");
  expect(answer).toContain("Desempate explícito");
  expect(answer).toContain("Sem isso:");
});

test("at the checkpoint the tutor points to the real code for the selected concept", () => {
  const selection = { file: "classifier.ts", startLine: 18, endLine: 18, text: "const TIE_BREAK = [Category.INCIDENT, Category.ACCESS, Category.BUG];" };
  const answer = offlineAnswer(tutorContext(journey, checkpoint, selection), "por que precisamos disso?");
  // Regression: the incidental "Category" in the selection must not win over the concept.
  expect(answer).toContain("CATEGORY_TIE_BREAK");
});

test("offline tutor names the next limitation when asked", () => {
  expect(offlineAnswer(tutorContext(journey, first), "Qual é a limitação desta versão?")).toContain("lunch menu");
});

test("offline tutor points to the real project when asked where", () => {
  expect(offlineAnswer(tutorContext(journey, checkpoint), "onde isso está no projeto real?")).toContain("deterministic-triage-classifier.ts");
  expect(offlineAnswer(tutorContext(journey, first), "onde isso está no projeto real?")).toContain("checkpoint do módulo");
});

test("offline tutor falls back to the stage focus when nothing matches", () => {
  expect(offlineAnswer(tutorContext(journey, first), "olá")).toContain(first.goal);
});

test("offline tutor walks through the solution lines when asked", () => {
  const answer = offlineAnswer(tutorContext(journey, first), "O que cada linha faz?");
  expect(answer).toContain("function classify");
  expect(answer).toContain("Sempre a mesma resposta");
});
