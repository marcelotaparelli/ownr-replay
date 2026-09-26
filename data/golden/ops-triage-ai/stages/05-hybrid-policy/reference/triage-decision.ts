import type { ClassifierResult } from "./triage.ts";

export enum DecisionSource {
  DETERMINISTIC = "DETERMINISTIC",
  LLM = "LLM",
  HYBRID = "HYBRID",
  DETERMINISTIC_FALLBACK = "DETERMINISTIC_FALLBACK",
}

export enum HumanReviewReason {
  CLASSIFIER_DISAGREEMENT = "CLASSIFIER_DISAGREEMENT",
  LOW_CONFIDENCE = "LOW_CONFIDENCE",
  HIGH_SEVERITY = "HIGH_SEVERITY",
  LLM_UNAVAILABLE = "LLM_UNAVAILABLE",
}

export interface TriageDecision extends ClassifierResult {
  requiresHumanReview: boolean;
  decisionSource: DecisionSource;
  reviewReasons: HumanReviewReason[];
}
