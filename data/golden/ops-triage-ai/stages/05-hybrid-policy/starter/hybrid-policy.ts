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
    // TODO: LLM falhou → resultado determinístico, fonte DETERMINISTIC_FALLBACK, motivo LLM_UNAVAILABLE
    //       (além de LOW_CONFIDENCE / HIGH_SEVERITY do determinístico, se houver).
    // TODO: LLM respondeu → resultado do LLM, fonte HYBRID; CLASSIFIER_DISAGREEMENT se categoria,
    //       prioridade ou risco diferirem; LOW_CONFIDENCE / HIGH_SEVERITY se QUALQUER um dos dois indicar.
    // Motivos sempre na ordem de REVIEW_REASON_ORDER.
    throw new Error("não implementado");
  }

  decideSingle(result: ClassifierResult, source: DecisionSource.DETERMINISTIC | DecisionSource.LLM): TriageDecision {
    const reasons: HumanReviewReason[] = [];
    if (result.confidence === 0.5) reasons.push(HumanReviewReason.LOW_CONFIDENCE);
    if (isHighSeverity(result)) reasons.push(HumanReviewReason.HIGH_SEVERITY);
    return decision(result, source, reasons);
  }
}

function isHighSeverity(result: ClassifierResult): boolean {
  return result.priority === Priority.HIGH || result.priority === Priority.CRITICAL || result.risk === Risk.HIGH;
}

function decision(result: ClassifierResult, decisionSource: DecisionSource, reviewReasons: HumanReviewReason[]): TriageDecision {
  return { ...result, requiresHumanReview: reviewReasons.length > 0, decisionSource, reviewReasons };
}
