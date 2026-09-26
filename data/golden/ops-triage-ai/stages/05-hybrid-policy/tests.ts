import { test, expect } from "replay:test";
import { ClassifierTimeoutError } from "./classifier-errors.ts";
import { HybridPolicy } from "./hybrid-policy.ts";
import { DecisionSource, HumanReviewReason } from "./triage-decision.ts";
import { TriageTicket } from "./triage-ticket.ts";
import { Category, Priority, Risk, SuggestedTeam, type ClassifierResult } from "./triage.ts";
import type { TriageClassifier } from "./triage-classifier.ts";

const R = HumanReviewReason;
const bug: ClassifierResult = {
  category: Category.BUG, priority: Priority.MEDIUM, risk: Risk.LOW,
  suggestedTeam: SuggestedTeam.DEVELOPMENT, confidence: 0.9, summary: "Checkout broken", rationale: "bug",
};
const policy = new HybridPolicy();
const available = (result: ClassifierResult) => ({ status: "available" as const, result });

test("concordância confiante: decide o LLM, sem revisão", () => {
  const llm = { ...bug, rationale: "llm" };
  const decision = policy.decide({ deterministic: bug, llm: available(llm) });
  expect(decision).toEqual({ ...llm, requiresHumanReview: false, decisionSource: DecisionSource.HYBRID, reviewReasons: [] });
});

test("discordância de categoria pede revisão, mas usa o LLM", () => {
  const llm = { ...bug, category: Category.ACCESS, suggestedTeam: SuggestedTeam.SUPPORT };
  const decision = policy.decide({ deterministic: bug, llm: available(llm) });
  expect(decision.category).toBe(Category.ACCESS);
  expect(decision.reviewReasons).toEqual([R.CLASSIFIER_DISAGREEMENT]);
});

test("discordar só na prioridade também é discordância", () => {
  const decision = policy.decide({ deterministic: bug, llm: available({ ...bug, priority: Priority.LOW }) });
  expect(decision.reviewReasons).toEqual([R.CLASSIFIER_DISAGREEMENT]);
});

test("LLM fora do ar: fallback para o determinístico", () => {
  const decision = policy.decide({ deterministic: bug, llm: { status: "failed", reason: "TIMEOUT" } });
  expect(decision).toEqual({ ...bug, requiresHumanReview: true, decisionSource: DecisionSource.DETERMINISTIC_FALLBACK, reviewReasons: [R.LLM_UNAVAILABLE] });
});

test("severidade alta em QUALQUER classificador pede revisão (conservador)", () => {
  const deterministic = { ...bug, risk: Risk.HIGH };
  const llm = available({ ...bug, risk: Risk.HIGH });
  expect(policy.decide({ deterministic, llm }).reviewReasons).toEqual([R.HIGH_SEVERITY]);
});

test("motivos em ordem estável", () => {
  const deterministic = { ...bug, confidence: 0.5 as const, priority: Priority.CRITICAL };
  const decision = policy.decide({ deterministic, llm: available(bug) });
  expect(decision.reviewReasons).toEqual([R.CLASSIFIER_DISAGREEMENT, R.LOW_CONFIDENCE, R.HIGH_SEVERITY]);
});

test("TriageTicket transforma timeout do LLM em fallback (não em erro)", async () => {
  const deterministic: TriageClassifier = { classify: async () => bug };
  const llm: TriageClassifier = {
    classify: async () => {
      throw new ClassifierTimeoutError();
    },
  };
  const decision = await new TriageTicket(deterministic, llm).execute({ title: "x", description: "y" });
  expect(decision.decisionSource).toBe(DecisionSource.DETERMINISTIC_FALLBACK);
});
