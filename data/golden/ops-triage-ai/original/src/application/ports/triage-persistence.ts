import type { TicketInput, ClassifierResult } from "../../domain/triage.ts";
import {
  DecisionSource,
  HumanReviewReason,
  type TriageDecision,
} from "../../domain/triage-decision.ts";

export type TriageMode = "DETERMINISTIC" | "OLLAMA" | "HYBRID";

export type TriageRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "ABANDONED";

export type TriageFailureCode =
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "UNEXPECTED"
  | "ABANDONED";

export interface StartTriageRun {
  ticketId: string;
  runId: string;
  mode: TriageMode;
  ticket: TicketInput;
}

export interface CompleteTriageRun {
  runId: string;
  decisionId: string;
  decision: TriageDecision;
  completedAt: Date;
}

export interface FailTriageRun {
  runId: string;
  failureCode: TriageFailureCode;
  completedAt: Date;
}

export interface PersistedTicket {
  id: string;
  title: string;
  description: string;
  createdAt: Date;
}

export interface PersistedTriageRun {
  id: string;
  ticketId: string;
  mode: TriageMode;
  status: TriageRunStatus;
  failureCode: TriageFailureCode | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface PersistedTriageDecision extends ClassifierResult {
  id: string;
  triageRunId: string;
  decisionSource: DecisionSource;
  requiresHumanReview: boolean;
  reviewReasons: HumanReviewReason[];
  createdAt: Date;
}

export interface CreateFeedback {
  id: string;
  decisionId: string;
  reviewedBy: string;
  correctedCategory: ClassifierResult["category"];
  correctedPriority: ClassifierResult["priority"];
  correctedRisk: ClassifierResult["risk"];
  correctedSuggestedTeam: ClassifierResult["suggestedTeam"];
  comment?: string;
}

export interface FeedbackRecord extends Omit<CreateFeedback, "comment"> {
  comment: string | null;
  createdAt: Date;
}

export interface TriageAuditRecord {
  ticket: PersistedTicket;
  run: PersistedTriageRun;
  decision: PersistedTriageDecision;
  feedback: FeedbackRecord[];
}

export interface TriageRunRepository {
  start(input: StartTriageRun): Promise<void>;
  complete(input: CompleteTriageRun): Promise<void>;
  fail(input: FailTriageRun): Promise<void>;
  reconcileStaleRuns?(cutoff: Date): Promise<number>;
  getStatusCounts?(): Promise<Record<TriageRunStatus, number>>;
  findDecisionAudit(decisionId: string): Promise<TriageAuditRecord | null>;
}

export interface FeedbackRepository {
  create(input: CreateFeedback): Promise<FeedbackRecord>;
}
