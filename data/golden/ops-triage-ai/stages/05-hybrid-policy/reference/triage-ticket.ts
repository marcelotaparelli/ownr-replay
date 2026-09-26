import { ClassifierInvalidResponseError, ClassifierTimeoutError, ClassifierUnavailableError } from "./classifier-errors.ts";
import { HybridPolicy, type LlmFailureReason, type LlmOutcome } from "./hybrid-policy.ts";
import type { TriageDecision } from "./triage-decision.ts";
import type { TicketInput } from "./triage.ts";
import type { TriageClassifier } from "./triage-classifier.ts";

export class TriageTicket {
  constructor(
    private readonly deterministic: TriageClassifier,
    private readonly llm: TriageClassifier,
    private readonly policy = new HybridPolicy(),
  ) {}

  async execute(input: TicketInput): Promise<TriageDecision> {
    const deterministic = await this.deterministic.classify(input);
    const llm = await classifyWithFallback(this.llm, input);
    return this.policy.decide({ deterministic, llm });
  }
}

// Falhas esperadas do LLM viram dados; qualquer outro erro continua sendo erro.
async function classifyWithFallback(classifier: TriageClassifier, input: TicketInput): Promise<LlmOutcome> {
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
