import { Priority, Risk, type ClassifierResult } from "./triage.ts";

export enum DecisionSource {
  DETERMINISTIC = "DETERMINISTIC",
  LLM = "LLM",
}

export enum HumanReviewReason {
  LOW_CONFIDENCE = "LOW_CONFIDENCE",
  HIGH_SEVERITY = "HIGH_SEVERITY",
}

// A decisão final = resultado do classificador + se um humano precisa revisar.
export interface TriageDecision extends ClassifierResult {
  requiresHumanReview: boolean;
  decisionSource: DecisionSource;
  reviewReasons: HumanReviewReason[];
}

export function decideSingle(result: ClassifierResult, source: DecisionSource): TriageDecision {
  const reasons: HumanReviewReason[] = [];
  if (result.confidence === 0.5) reasons.push(HumanReviewReason.LOW_CONFIDENCE);
  if (isHighSeverity(result)) reasons.push(HumanReviewReason.HIGH_SEVERITY);
  return {
    ...result,
    requiresHumanReview: reasons.length > 0,
    decisionSource: source,
    reviewReasons: reasons,
  };
}

function isHighSeverity(result: ClassifierResult): boolean {
  return (
    result.priority === Priority.HIGH ||
    result.priority === Priority.CRITICAL ||
    result.risk === Risk.HIGH
  );
}
