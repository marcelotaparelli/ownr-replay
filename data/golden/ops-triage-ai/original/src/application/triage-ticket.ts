import {
  ClassifierInvalidResponseError,
  ClassifierTimeoutError,
  ClassifierUnavailableError,
} from "./errors/classifier-errors.ts";
import type { TriageClassifier } from "./ports/triage-classifier.ts";
import {
  HybridPolicy,
  type LlmFailureReason,
  type LlmOutcome,
} from "./policies/hybrid-policy.ts";
import { DecisionSource, type TriageDecision } from "../domain/triage-decision.ts";
import type { TicketInput } from "../domain/triage.ts";

export type TriageTicketMode =
  | { mode: "deterministic"; classifier: TriageClassifier }
  | { mode: "ollama"; classifier: TriageClassifier }
  | {
      mode: "hybrid";
      deterministicClassifier: TriageClassifier;
      llmClassifier: TriageClassifier;
    };

export class TriageTicket {
  constructor(
    private readonly configuration: TriageTicketMode,
    private readonly policy = new HybridPolicy(),
  ) {}

  async execute(input: TicketInput): Promise<TriageDecision> {
    if (this.configuration.mode === "deterministic") {
      const result = await this.configuration.classifier.classify(input);
      return this.policy.decideSingle(result, DecisionSource.DETERMINISTIC);
    }

    if (this.configuration.mode === "ollama") {
      const result = await this.configuration.classifier.classify(input);
      return this.policy.decideSingle(result, DecisionSource.LLM);
    }

    const deterministic = await this.configuration.deterministicClassifier.classify(input);
    const llm = await classifyWithLlmFallback(this.configuration.llmClassifier, input);
    return this.policy.decide({ deterministic, llm });
  }
}

async function classifyWithLlmFallback(
  classifier: TriageClassifier,
  input: TicketInput,
): Promise<LlmOutcome> {
  try {
    return { status: "available", result: await classifier.classify(input) };
  } catch (error) {
    const reason = failureReason(error);
    if (!reason) throw error;
    return { status: "failed", reason };
  }
}

function failureReason(error: unknown): LlmFailureReason | undefined {
  if (error instanceof ClassifierTimeoutError) return "TIMEOUT";
  if (error instanceof ClassifierUnavailableError) return "UNAVAILABLE";
  if (error instanceof ClassifierInvalidResponseError) return "INVALID_RESPONSE";
  return undefined;
}
