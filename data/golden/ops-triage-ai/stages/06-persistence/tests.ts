import { test, expect } from "ownr:test";
import { ClassifierTimeoutError } from "./classifier-errors.ts";
import { InMemoryTriageRuns } from "./in-memory-runs.ts";
import { PersistedTriageService, type TriageUseCase } from "./persisted-triage-service.ts";
import { DecisionSource, type TriageDecision } from "./triage-decision.ts";
import { Category, Priority, Risk, SuggestedTeam } from "./triage.ts";

const ticket = { title: "Production is down", description: "All users see 500" };
const decision: TriageDecision = {
  category: Category.INCIDENT, priority: Priority.CRITICAL, risk: Risk.HIGH, suggestedTeam: SuggestedTeam.INFRASTRUCTURE,
  confidence: 0.9, summary: "Production is down", rationale: "production_down",
  requiresHumanReview: true, decisionSource: DecisionSource.HYBRID, reviewReasons: [],
};
const ok: TriageUseCase = { execute: async () => decision };
const failing = (error: Error): TriageUseCase => ({
  execute: async () => {
    throw error;
  },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("sucesso: start → complete, e o id da decisão é devolvido", async () => {
  const runs = new InMemoryTriageRuns();
  const result = await new PersistedTriageService(ok, runs).execute(ticket);
  expect(result.decision).toEqual(decision);
  expect(result.decisionId).toMatch(UUID);
  expect(runs.log).toEqual(["start", "complete"]);
  expect([...runs.runs.values()][0]?.decisionId).toBe(result.decisionId);
});

test("o run é registrado antes da classificação começar", async () => {
  const runs = new InMemoryTriageRuns();
  let seenAtClassification: string[] = [];
  const spy: TriageUseCase = {
    execute: async () => {
      seenAtClassification = [...runs.log];
      return decision;
    },
  };
  await new PersistedTriageService(spy, runs).execute(ticket);
  expect(seenAtClassification).toEqual(["start"]);
});

test("timeout do classificador: run FAILED com TIMEOUT e o erro original sobe", async () => {
  const runs = new InMemoryTriageRuns();
  const error = new ClassifierTimeoutError();
  await expect(() => new PersistedTriageService(failing(error), runs).execute(ticket)).rejects.toBeInstanceOf(ClassifierTimeoutError);
  expect(runs.log).toEqual(["start", "fail:TIMEOUT"]);
});

test("erro inesperado vira UNEXPECTED", async () => {
  const runs = new InMemoryTriageRuns();
  await expect(() => new PersistedTriageService(failing(new RangeError("bug")), runs).execute(ticket)).rejects.toBeInstanceOf(RangeError);
  expect(runs.log).toEqual(["start", "fail:UNEXPECTED"]);
});

test("se registrar a falha também falhar, o erro original ainda é o que sobe", async () => {
  const runs = new InMemoryTriageRuns();
  runs.fail = async () => {
    throw new Error("database down");
  };
  await expect(() => new PersistedTriageService(failing(new ClassifierTimeoutError()), runs).execute(ticket)).rejects.toBeInstanceOf(ClassifierTimeoutError);
});
