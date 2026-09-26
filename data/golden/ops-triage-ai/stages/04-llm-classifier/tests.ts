import { test, expect } from "replay:test";
import { ClassifierInvalidResponseError, ClassifierTimeoutError, ClassifierUnavailableError } from "./classifier-errors.ts";
import { LlmTriageClassifier, type HttpFetch } from "./llm-triage-classifier.ts";
import { Category, Priority, Risk, SuggestedTeam } from "./triage.ts";

const ticket = { title: "Cannot login", description: "Access denied since the MFA change" };
const config = { baseUrl: "http://llm.test", model: "test-model", timeoutMs: 30 };
const valid = { category: "ACCESS", priority: "MEDIUM", risk: "LOW", confidence: 0.7, summary: "Cannot login", rationale: "login blocked" };

const replying = (content: string, status = 200): HttpFetch => async () =>
  new Response(JSON.stringify({ message: { content } }), { status });

test("resposta válida vira ClassifierResult, com time derivado da categoria", async () => {
  const result = await new LlmTriageClassifier(config, replying(JSON.stringify({ ...valid }))).classify(ticket);
  expect(result).toEqual({ ...valid, category: Category.ACCESS, priority: Priority.MEDIUM, risk: Risk.LOW, suggestedTeam: SuggestedTeam.SUPPORT });
});

test("falha de rede → ClassifierUnavailableError", async () => {
  const down: HttpFetch = async () => {
    throw new TypeError("fetch failed");
  };
  await expect(() => new LlmTriageClassifier(config, down).classify(ticket)).rejects.toBeInstanceOf(ClassifierUnavailableError);
});

test("HTTP 500 → ClassifierUnavailableError", async () => {
  await expect(() => new LlmTriageClassifier(config, replying("{}", 500)).classify(ticket)).rejects.toBeInstanceOf(ClassifierUnavailableError);
});

test("LLM travado → ClassifierTimeoutError (o fetch é cancelado)", async () => {
  let aborted = false;
  const hanging: HttpFetch = (_url, init) =>
    new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  await expect(() => new LlmTriageClassifier(config, hanging).classify(ticket)).rejects.toBeInstanceOf(ClassifierTimeoutError);
  expect(aborted).toBe(true);
});

test("conteúdo que não é JSON → ClassifierInvalidResponseError", async () => {
  await expect(() => new LlmTriageClassifier(config, replying("Claro! A categoria é ACCESS.")).classify(ticket)).rejects.toBeInstanceOf(ClassifierInvalidResponseError);
});

test("categoria inventada pelo LLM → ClassifierInvalidResponseError", async () => {
  const invented = JSON.stringify({ ...valid, category: "SECURITY" });
  await expect(() => new LlmTriageClassifier(config, replying(invented)).classify(ticket)).rejects.toBeInstanceOf(ClassifierInvalidResponseError);
});

test("o LLM não consegue escolher o time", async () => {
  const sneaky = JSON.stringify({ ...valid, suggestedTeam: "INFRASTRUCTURE" });
  await expect(() => new LlmTriageClassifier(config, replying(sneaky)).classify(ticket)).rejects.toBeInstanceOf(ClassifierInvalidResponseError);
});
