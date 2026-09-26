import type { TriageDecision } from "./triage-decision.ts";
import type { TicketInput } from "./triage.ts";

export type TriageRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED";
export type TriageFailureCode = "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE" | "UNEXPECTED";

// A porta: a aplicação diz o que precisa; Prisma, SQLite ou memória implementam.
export interface TriageRunRepository {
  start(input: { runId: string; ticketId: string; ticket: TicketInput }): Promise<void>;
  complete(input: { runId: string; decisionId: string; decision: TriageDecision; completedAt: Date }): Promise<void>;
  fail(input: { runId: string; failureCode: TriageFailureCode; completedAt: Date }): Promise<void>;
}
