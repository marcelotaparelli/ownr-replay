import { Priority, Risk, type ClassifierResult } from "./triage.ts";

export enum DecisionSource {
  DETERMINISTIC = "DETERMINISTIC",
  LLM = "LLM",
}

export enum HumanReviewReason {
  LOW_CONFIDENCE = "LOW_CONFIDENCE",
  HIGH_SEVERITY = "HIGH_SEVERITY",
}

export interface TriageDecision extends ClassifierResult {
  requiresHumanReview: boolean;
  decisionSource: DecisionSource;
  reviewReasons: HumanReviewReason[];
}

export function decideSingle(result: ClassifierResult, source: DecisionSource): TriageDecision {
  // TODO: copie o resultado e acrescente a decisão.
  // Confiança 0.5 → LOW_CONFIDENCE. Prioridade HIGH/CRITICAL ou risco HIGH → HIGH_SEVERITY.
  // Nessa ordem. Revisão humana é necessária se houver qualquer motivo.
  throw new Error("não implementado");
}
