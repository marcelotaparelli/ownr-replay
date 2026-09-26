import { DecisionSource, HumanReviewReason, type TriageDecision } from "./triage-decision.ts";
import { Priority, Risk, type ClassifierResult } from "./triage.ts";

export type LlmFailureReason = "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE";

// O LLM respondeu OU falhou — nunca "talvez null".
export type LlmOutcome =
  | { status: "available"; result: ClassifierResult }
  | { status: "failed"; reason: LlmFailureReason };

const REVIEW_REASON_ORDER: readonly HumanReviewReason[] = [
  HumanReviewReason.CLASSIFIER_DISAGREEMENT,
  HumanReviewReason.LOW_CONFIDENCE,
  HumanReviewReason.HIGH_SEVERITY,
  HumanReviewReason.LLM_UNAVAILABLE,
];

export class HybridPolicy {
  decide(input: { deterministic: ClassifierResult; llm: LlmOutcome }): TriageDecision {
    if (input.llm.status === "failed") {
      return decision(input.deterministic, DecisionSource.DETERMINISTIC_FALLBACK, reviewReasons([input.deterministic], false, true));
    }
    const llm = input.llm.result;
    const disagree = classifiersDisagree(input.deterministic, llm);
    // O LLM decide; o determinístico vigia.
    return decision(llm, DecisionSource.HYBRID, reviewReasons([input.deterministic, llm], disagree, false));
  }

  decideSingle(result: ClassifierResult, source: DecisionSource.DETERMINISTIC | DecisionSource.LLM): TriageDecision {
    return decision(result, source, reviewReasons([result], false, false));
  }
}

function classifiersDisagree(a: ClassifierResult, b: ClassifierResult): boolean {
  return a.category !== b.category || a.priority !== b.priority || a.risk !== b.risk;
}

function reviewReasons(results: readonly ClassifierResult[], disagreement: boolean, llmUnavailable: boolean): HumanReviewReason[] {
  const reasons = new Set<HumanReviewReason>();
  if (disagreement) reasons.add(HumanReviewReason.CLASSIFIER_DISAGREEMENT);
  if (results.some((r) => r.confidence === 0.5)) reasons.add(HumanReviewReason.LOW_CONFIDENCE);
  if (results.some(isHighSeverity)) reasons.add(HumanReviewReason.HIGH_SEVERITY);
  if (llmUnavailable) reasons.add(HumanReviewReason.LLM_UNAVAILABLE);
  return REVIEW_REASON_ORDER.filter((reason) => reasons.has(reason));
}

function isHighSeverity(result: ClassifierResult): boolean {
  return result.priority === Priority.HIGH || result.priority === Priority.CRITICAL || result.risk === Risk.HIGH;
}

function decision(result: ClassifierResult, decisionSource: DecisionSource, reviewReasons: HumanReviewReason[]): TriageDecision {
  return { ...result, requiresHumanReview: reviewReasons.length > 0, decisionSource, reviewReasons };
}
