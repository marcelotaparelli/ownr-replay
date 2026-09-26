import { PrismaClient, Prisma } from "../../generated/prisma/client.ts";
import {
  Category,
  Priority,
  Risk,
  SuggestedTeam,
  type ClassifierResult,
} from "../../domain/triage.ts";
import {
  DecisionSource,
  HumanReviewReason,
} from "../../domain/triage-decision.ts";
import type {
  CompleteTriageRun,
  CreateFeedback,
  FailTriageRun,
  FeedbackRecord,
  PersistedTriageDecision,
  PersistedTriageRun,
  PersistedTicket,
  StartTriageRun,
  TriageAuditRecord,
  TriageFailureCode,
  TriageMode,
  TriageRunRepository,
  TriageRunStatus,
} from "../../application/ports/triage-persistence.ts";
import type { FeedbackRepository } from "../../application/ports/triage-persistence.ts";

type PrismaTransaction = Prisma.TransactionClient;

export class PrismaTriageRunRepository implements TriageRunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async start(input: StartTriageRun): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.create({
        data: {
          id: input.ticketId,
          title: input.ticket.title,
          description: input.ticket.description,
        },
      });
      await tx.triageRun.create({
        data: {
          id: input.runId,
          ticketId: input.ticketId,
          mode: toPrismaTriageMode(input.mode),
          status: "RUNNING",
        },
      });
    });
  }

  async complete(input: CompleteTriageRun): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await createDecision(tx, input);
      await tx.triageRun.update({
        where: { id: input.runId },
        data: {
          status: "SUCCEEDED",
          failureCode: null,
          completedAt: input.completedAt,
        },
      });
    });
  }

  async fail(input: FailTriageRun): Promise<void> {
    await this.prisma.triageRun.update({
      where: { id: input.runId },
      data: {
        status: "FAILED",
        failureCode: input.failureCode,
        completedAt: input.completedAt,
      },
    });
  }

  async reconcileStaleRuns(cutoff: Date): Promise<number> {
    const result = await this.prisma.triageRun.updateMany({
      where: { status: "RUNNING", startedAt: { lt: cutoff } },
      data: { status: "ABANDONED", failureCode: "ABANDONED", completedAt: new Date() },
    });
    return result.count;
  }

  async getStatusCounts(): Promise<Record<TriageRunStatus, number>> {
    const statuses: TriageRunStatus[] = ["RUNNING", "SUCCEEDED", "FAILED", "ABANDONED"];
    const entries = await Promise.all(statuses.map(async (status) => [
      status,
      await this.prisma.triageRun.count({ where: { status } }),
    ] as const));
    return Object.fromEntries(entries) as Record<TriageRunStatus, number>;
  }

  async findDecisionAudit(decisionId: string): Promise<TriageAuditRecord | null> {
    const row = await this.prisma.triageDecision.findUnique({
      where: { id: decisionId },
      include: {
        triageRun: { include: { ticket: true } },
        feedback: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!row) return null;

    return {
      ticket: mapTicket(row.triageRun.ticket),
      run: mapRun(row.triageRun),
      decision: mapDecision(row),
      feedback: row.feedback.map(mapFeedback),
    };
  }
}

export class PrismaFeedbackRepository implements FeedbackRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateFeedback): Promise<FeedbackRecord> {
    const row = await this.prisma.feedback.create({
      data: {
        id: input.id,
        decisionId: input.decisionId,
        reviewedBy: input.reviewedBy,
        correctedCategory: input.correctedCategory,
        correctedPriority: input.correctedPriority,
        correctedRisk: input.correctedRisk,
        correctedSuggestedTeam: input.correctedSuggestedTeam,
        comment: input.comment ?? null,
      },
    });
    return mapFeedback(row);
  }
}

async function createDecision(
  tx: PrismaTransaction,
  input: CompleteTriageRun,
): Promise<void> {
  await tx.triageDecision.create({
    data: {
      id: input.decisionId,
      triageRunId: input.runId,
      category: input.decision.category,
      priority: input.decision.priority,
      risk: input.decision.risk,
      suggestedTeam: input.decision.suggestedTeam,
      confidence: input.decision.confidence,
      summary: input.decision.summary,
      rationale: input.decision.rationale,
      decisionSource: input.decision.decisionSource,
      requiresHumanReview: input.decision.requiresHumanReview,
      reviewReasons: input.decision.reviewReasons,
    },
  });
}

function mapTicket(row: {
  id: string;
  title: string;
  description: string;
  createdAt: Date;
}): PersistedTicket {
  return row;
}

function mapRun(row: {
  id: string;
  ticketId: string;
  mode: string;
  status: string;
  failureCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
}): PersistedTriageRun {
  return {
    id: row.id,
    ticketId: row.ticketId,
    mode: toTriageMode(row.mode),
    status: toTriageRunStatus(row.status),
    failureCode: row.failureCode === null ? null : toTriageFailureCode(row.failureCode),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function mapDecision(row: {
  id: string;
  triageRunId: string;
  category: string;
  priority: string;
  risk: string;
  suggestedTeam: string;
  confidence: Prisma.Decimal;
  summary: string;
  rationale: string;
  decisionSource: string;
  requiresHumanReview: boolean;
  reviewReasons: string[];
  createdAt: Date;
}): PersistedTriageDecision {
  return {
    id: row.id,
    triageRunId: row.triageRunId,
    category: toCategory(row.category),
    priority: toPriority(row.priority),
    risk: toRisk(row.risk),
    suggestedTeam: toSuggestedTeam(row.suggestedTeam),
    confidence: toConfidence(Number(row.confidence)),
    summary: row.summary,
    rationale: row.rationale,
    decisionSource: toDecisionSource(row.decisionSource),
    requiresHumanReview: row.requiresHumanReview,
    reviewReasons: row.reviewReasons.map(toReviewReason),
    createdAt: row.createdAt,
  };
}

function mapFeedback(row: {
  id: string;
  decisionId: string;
  reviewedBy: string;
  correctedCategory: string;
  correctedPriority: string;
  correctedRisk: string;
  correctedSuggestedTeam: string;
  comment: string | null;
  createdAt: Date;
}): FeedbackRecord {
  return {
    id: row.id,
    decisionId: row.decisionId,
    reviewedBy: row.reviewedBy,
    correctedCategory: toCategory(row.correctedCategory),
    correctedPriority: toPriority(row.correctedPriority),
    correctedRisk: toRisk(row.correctedRisk),
    correctedSuggestedTeam: toSuggestedTeam(row.correctedSuggestedTeam),
    comment: row.comment,
    createdAt: row.createdAt,
  };
}

function toPrismaTriageMode(value: TriageMode) {
  return value;
}

function toTriageMode(value: string): TriageMode {
  if (value === "DETERMINISTIC" || value === "OLLAMA" || value === "HYBRID") return value;
  throw new Error(`Unexpected persisted triage mode: ${value}`);
}

function toTriageRunStatus(value: string): TriageRunStatus {
  if (value === "RUNNING" || value === "SUCCEEDED" || value === "FAILED" || value === "ABANDONED") return value;
  throw new Error(`Unexpected persisted triage run status: ${value}`);
}

function toTriageFailureCode(value: string): TriageFailureCode {
  if (
    value === "TIMEOUT" ||
    value === "UNAVAILABLE" ||
    value === "INVALID_RESPONSE" ||
    value === "UNEXPECTED" ||
    value === "ABANDONED"
  ) {
    return value;
  }
  throw new Error(`Unexpected persisted triage failure code: ${value}`);
}

function toCategory(value: string): Category {
  if (Object.values(Category).includes(value as Category)) return value as Category;
  throw new Error(`Unexpected persisted category: ${value}`);
}

function toPriority(value: string): Priority {
  if (Object.values(Priority).includes(value as Priority)) return value as Priority;
  throw new Error(`Unexpected persisted priority: ${value}`);
}

function toRisk(value: string): Risk {
  if (Object.values(Risk).includes(value as Risk)) return value as Risk;
  throw new Error(`Unexpected persisted risk: ${value}`);
}

function toSuggestedTeam(value: string): ClassifierResult["suggestedTeam"] {
  if (Object.values(SuggestedTeam).includes(value as SuggestedTeam)) {
    return value as SuggestedTeam;
  }
  throw new Error(`Unexpected persisted suggested team: ${value}`);
}

function toDecisionSource(value: string): DecisionSource {
  if (Object.values(DecisionSource).includes(value as DecisionSource)) {
    return value as DecisionSource;
  }
  throw new Error(`Unexpected persisted decision source: ${value}`);
}

function toReviewReason(value: string): HumanReviewReason {
  if (Object.values(HumanReviewReason).includes(value as HumanReviewReason)) {
    return value as HumanReviewReason;
  }
  throw new Error(`Unexpected persisted review reason: ${value}`);
}

function toConfidence(value: number): ClassifierResult["confidence"] {
  if (value === 0.5 || value === 0.7 || value === 0.9) return value;
  throw new Error(`Unexpected persisted confidence: ${value}`);
}
