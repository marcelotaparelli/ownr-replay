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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.config.baseUrl + "/api/chat", {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.config.model, stream: false, messages: [{ role: "user", content: prompt(input) }] }),
        });
      } catch {
        throw controller.signal.aborted ? new ClassifierTimeoutError() : new ClassifierUnavailableError();
      }
      if (!response.ok) throw new ClassifierUnavailableError();

      const result = parseLlmResult(await readContent(response));
      if (!result) throw new ClassifierInvalidResponseError();
      // O LLM não escolhe o time: ele é derivado da categoria.
      return { ...result, suggestedTeam: suggestedTeamForCategory(result.category) };
    } finally {
      clearTimeout(timer);
    }
  }
}

// Envelope { message: { content: "<json>" } } → objeto; qualquer desvio é resposta inválida.
async function readContent(response: Response): Promise<unknown> {
  try {
    const envelope = await response.json();
    return JSON.parse(envelope.message.content);
  } catch {
    throw new ClassifierInvalidResponseError();
  }
}

function prompt(input: TicketInput): string {
  return `Classifique o ticket.\nTítulo: ${input.title}\nDescrição: ${input.description}`;
}
