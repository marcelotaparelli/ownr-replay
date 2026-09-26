import { test, expect } from "replay:test";
import { ClassifierInvalidResponseError, ClassifierTimeoutError, ClassifierUnavailableError } from "./classifier-errors.ts";
import { handleTriage, type TriageService } from "./http.ts";
import { parseTicketInput } from "./triage-request.ts";
import { DecisionSource, type TriageDecision } from "./triage-decision.ts";
import { Category, Priority, Risk, SuggestedTeam } from "./triage.ts";

const decision: TriageDecision = {
  category: Category.BUG, priority: Priority.MEDIUM, risk: Risk.LOW, suggestedTeam: SuggestedTeam.DEVELOPMENT,
  confidence: 0.9, summary: "x", rationale: "y", requiresHumanReview: false, decisionSource: DecisionSource.HYBRID, reviewReasons: [],
};
const ok: TriageService = { execute: async () => ({ decisionId: "d-1", decision }) };
const throwing = (error: Error): TriageService => ({
  execute: async () => {
    throw error;
  },
});
const post = (body: string, type = "application/json") =>
  new Request("http://test/tickets/triage", { method: "POST", headers: { "content-type": type }, body });

test("entrada válida é normalizada (trim)", () => {
  expect(parseTicketInput({ title: "  Bug  ", description: " broken " })).toEqual({ success: true, data: { title: "Bug", description: "broken" } });
});

test("campos ausentes, vazios, longos ou extras viram issues", () => {
  const result = parseTicketInput({ title: "   ", description: "x".repeat(5_001), admin: true });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.issues).toContain({ field: "title", code: "too_small" });
    expect(result.issues).toContain({ field: "description", code: "too_big" });
    expect(result.issues).toContain({ field: "admin", code: "unrecognized_key" });
  }
  expect(parseTicketInput(null).success).toBe(false);
  expect(parseTicketInput({ title: 1, description: "x" }).success).toBe(false);
});

test("201 com Location e a decisão no corpo", async () => {
  const response = await handleTriage(post(JSON.stringify({ title: "Bug", description: "broken" })), ok);
  expect(response.status).toBe(201);
  expect(response.headers.get("location")).toBe("/triage/d-1");
  expect((await response.json()).id).toBe("d-1");
});

test("protocolo errado: 415, 400, 422", async () => {
  expect((await handleTriage(post("{}", "text/plain"), ok)).status).toBe(415);
  expect((await handleTriage(post("{not json"), ok)).status).toBe(400);
  expect((await handleTriage(post(JSON.stringify({ title: "" })), ok)).status).toBe(422);
});

test("erros do classificador viram 504 / 503 / 502", async () => {
  const body = JSON.stringify({ title: "Bug", description: "broken" });
  expect((await handleTriage(post(body), throwing(new ClassifierTimeoutError()))).status).toBe(504);
  expect((await handleTriage(post(body), throwing(new ClassifierUnavailableError()))).status).toBe(503);
  expect((await handleTriage(post(body), throwing(new ClassifierInvalidResponseError()))).status).toBe(502);
});

test("erro inesperado vira 500 sem vazar detalhes", async () => {
  const response = await handleTriage(post(JSON.stringify({ title: "Bug", description: "x" })), throwing(new Error("password=hunter2 at db.ts:42")));
  expect(response.status).toBe(500);
  expect(await response.text()).toBe(JSON.stringify({ error: "internal_error" }));
});
