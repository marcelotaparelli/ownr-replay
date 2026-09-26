import {
  ClassifierInvalidResponseError,
  ClassifierTimeoutError,
  ClassifierUnavailableError,
} from "./classifier-errors.ts";
import { parseLlmResult } from "./llm-result.ts";
import { suggestedTeamForCategory } from "./suggested-team.ts";
import type { ClassifierResult, TicketInput } from "./triage.ts";
import type { TriageClassifier } from "./triage-classifier.ts";

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LlmClassifierConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export class LlmTriageClassifier implements TriageClassifier {
  constructor(
    private readonly config: LlmClassifierConfig,
    private readonly fetchImpl: HttpFetch = fetch,
  ) {}

  async classify(input: TicketInput): Promise<ClassifierResult> {
    // TODO 1: AbortController + setTimeout(config.timeoutMs) → abort(); limpe o timer no fim.
    // TODO 2: fetch falhou → ClassifierTimeoutError se abortado, senão ClassifierUnavailableError.
    // TODO 3: resposta HTTP não-ok → ClassifierUnavailableError.
    // TODO 4: envelope { message: { content } } com JSON inválido ou conteúdo que
    //         parseLlmResult rejeita → ClassifierInvalidResponseError.
    // TODO 5: suggestedTeam vem de suggestedTeamForCategory, nunca do LLM.
    const response = await this.fetchImpl(this.config.baseUrl + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.config.model, stream: false, messages: [{ role: "user", content: input.title }] }),
    });
    const envelope = await response.json();
    return JSON.parse(envelope.message.content);
  }
}
