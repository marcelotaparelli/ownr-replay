import { test, expect } from "replay:test";
import { Category, Priority, Risk, SuggestedTeam, type ClassifierResult } from "./triage.ts";
import { suggestedTeamForCategory } from "./suggested-team.ts";
import { DecisionSource, HumanReviewReason, decideSingle } from "./triage-decision.ts";

const base: ClassifierResult = {
  category: Category.BUG,
  priority: Priority.MEDIUM,
  risk: Risk.LOW,
  suggestedTeam: SuggestedTeam.DEVELOPMENT,
  confidence: 0.9,
  summary: "Checkout button broken",
  rationale: "BUG_HIGH_SIGNAL: bug",
};

test("cada categoria tem um time sugerido", () => {
  expect(suggestedTeamForCategory(Category.INCIDENT)).toBe(SuggestedTeam.INFRASTRUCTURE);
  expect(suggestedTeamForCategory(Category.BUG)).toBe(SuggestedTeam.DEVELOPMENT);
  expect(suggestedTeamForCategory(Category.ACCESS)).toBe(SuggestedTeam.SUPPORT);
  expect(suggestedTeamForCategory(Category.SUPPORT)).toBe(SuggestedTeam.SUPPORT);
  expect(suggestedTeamForCategory(Category.OTHER)).toBe(SuggestedTeam.HUMAN_REVIEW);
});

test("resultado confiante e de baixa severidade dispensa revisão", () => {
  const decision = decideSingle(base, DecisionSource.DETERMINISTIC);
  expect(decision).toEqual({ ...base, requiresHumanReview: false, decisionSource: DecisionSource.DETERMINISTIC, reviewReasons: [] });
});

test("confiança 0.5 pede revisão", () => {
  const decision = decideSingle({ ...base, confidence: 0.5 }, DecisionSource.LLM);
  expect(decision.requiresHumanReview).toBe(true);
  expect(decision.reviewReasons).toEqual([HumanReviewReason.LOW_CONFIDENCE]);
  expect(decision.decisionSource).toBe(DecisionSource.LLM);
});

test("prioridade HIGH/CRITICAL ou risco HIGH pedem revisão", () => {
  for (const change of [{ priority: Priority.HIGH }, { priority: Priority.CRITICAL }, { risk: Risk.HIGH }]) {
    expect(decideSingle({ ...base, ...change }, DecisionSource.DETERMINISTIC).reviewReasons).toEqual([HumanReviewReason.HIGH_SEVERITY]);
  }
});

test("motivos acumulam em ordem estável", () => {
  const decision = decideSingle({ ...base, confidence: 0.5, risk: Risk.HIGH }, DecisionSource.DETERMINISTIC);
  expect(decision.reviewReasons).toEqual([HumanReviewReason.LOW_CONFIDENCE, HumanReviewReason.HIGH_SEVERITY]);
});

test("não altera o resultado recebido", () => {
  const input = { ...base, confidence: 0.5 as const };
  decideSingle(input, DecisionSource.DETERMINISTIC);
  expect(input).toEqual({ ...base, confidence: 0.5 });
});
