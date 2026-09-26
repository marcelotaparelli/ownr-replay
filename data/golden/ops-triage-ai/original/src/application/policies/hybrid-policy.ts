import {
  DecisionSource,
  HumanReviewReason,
  type TriageDecision,
} from "../../domain/triage-decision.ts";
import {
  Priority,
  Risk,
  type ClassifierResult,
} from "../../domain/triage.ts";

export type LlmFailureReason = "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE";

export type LlmOutcome =
  | { status: "available"; result: ClassifierResult }
  | { status: "failed"; reason: LlmFailureReason };

export interface HybridPolicyInput {
  deterministic: ClassifierResult;
  llm: LlmOutcome;
}

type SingleDecisionSource = DecisionSource.DETERMINISTIC | DecisionSource.LLM;

const REVIEW_REASON_ORDER: readonly HumanReviewReason[] = [
  HumanReviewReason.CLASSIFIER_DISAGREEMENT,
  HumanReviewReason.LOW_CONFIDENCE,
  HumanReviewReason.HIGH_SEVERITY,
  HumanReviewReason.LLM_UNAVAILABLE,
];

export class HybridPolicy {
  decide(input: HybridPolicyInput): TriageDecision {
    if (input.llm.status === "failed") {
      return decision(
        input.deterministic,
        DecisionSource.DETERMINISTIC_FALLBACK,
        reviewReasons([input.deterministic], false, true),
      );
    }

    const results = [input.deterministic, input.llm.result];
    return decision(
      input.llm.result,
      DecisionSource.HYBRID,
      reviewReasons(
        results,
        classifiersDisagree(input.deterministic, input.llm.result),
        false,
      ),
    );
  }

  decideSingle(result: ClassifierResult, source: SingleDecisionSource): TriageDecision {
    return decision(result, source, reviewReasons([result], false, false));
  }
}

function classifiersDisagree(
  deterministic: ClassifierResult,
  llm: ClassifierResult,
): boolean {
  return (
    deterministic.category !== llm.category ||
    deterministic.priority !== llm.priority ||
    deterministic.risk !== llm.risk
  );
}

function reviewReasons(
  results: readonly ClassifierResult[],
  disagreement: boolean,
  llmUnavailable: boolean,
): HumanReviewReason[] {
  const reasons = new Set<HumanReviewReason>();
  if (disagreement) reasons.add(HumanReviewReason.CLASSIFIER_DISAGREEMENT);
  if (results.some(({ confidence }) => confidence === 0.5)) {
    reasons.add(HumanReviewReason.LOW_CONFIDENCE);
  }
  if (results.some(isHighSeverity)) reasons.add(HumanReviewReason.HIGH_SEVERITY);
  if (llmUnavailable) reasons.add(HumanReviewReason.LLM_UNAVAILABLE);
  return REVIEW_REASON_ORDER.filter((reason) => reasons.has(reason));
}

function isHighSeverity(result: ClassifierResult): boolean {
  return (
    result.priority === Priority.HIGH ||
    result.priority === Priority.CRITICAL ||
    result.risk === Risk.HIGH
  );
}

function decision(
  result: ClassifierResult,
  decisionSource: DecisionSource,
  reviewReasons: HumanReviewReason[],
): TriageDecision {
  return {
    ...result,
    requiresHumanReview: reviewReasons.length > 0,
    decisionSource,
    reviewReasons,
  };
}
