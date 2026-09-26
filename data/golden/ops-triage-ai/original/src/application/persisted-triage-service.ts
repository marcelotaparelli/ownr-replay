import {
  ClassifierInvalidResponseError,
  ClassifierTimeoutError,
  ClassifierUnavailableError,
} from "./errors/classifier-errors.ts";
import type { TriageTicket } from "./triage-ticket.ts";
import type {
  CreateFeedback,
  FeedbackRepository,
  TriageFailureCode,
  TriageMode,
  TriageRunRepository,
} from "./ports/triage-persistence.ts";
import type {
  FeedbackInput,
  TriageExecution,
  TriageService,
} from "./ports/triage-service.ts";
import type { TicketInput } from "../domain/triage.ts";
import { suggestedTeamForCategory } from "../domain/suggested-team.ts";

export class PersistedTriageService implements TriageService {
  constructor(
    private readonly triageTicket: TriageTicket,
    private readonly mode: TriageMode,
    private readonly triageRunRepository: TriageRunRepository,
    private readonly feedbackRepository: FeedbackRepository,
  ) {}

  async execute(input: TicketInput): Promise<TriageExecution> {
    const ticketId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    await this.triageRunRepository.start({
      ticketId,
      runId,
      mode: this.mode,
      ticket: input,
    });

    try {
      const decision = await this.triageTicket.execute(input);
      const decisionId = crypto.randomUUID();
      await this.triageRunRepository.complete({
        runId,
        decisionId,
        decision,
        completedAt: new Date(),
      });
      return { decisionId, decision };
    } catch (error) {
      await this.markFailed(runId, failureCode(error));
      throw error;
    }
  }

  getDecisionAudit(decisionId: string) {
    return this.triageRunRepository.findDecisionAudit(decisionId);
  }

  async addFeedback(decisionId: string, input: FeedbackInput) {
    const feedback: CreateFeedback = {
      id: crypto.randomUUID(),
      decisionId,
      reviewedBy: input.reviewedBy,
      correctedCategory: input.correctedCategory,
      correctedPriority: input.correctedPriority,
      correctedRisk: input.correctedRisk,
      correctedSuggestedTeam: suggestedTeamForCategory(input.correctedCategory),
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    };
    return this.feedbackRepository.create(feedback);
  }

  private async markFailed(runId: string, code: TriageFailureCode): Promise<void> {
    try {
      await this.triageRunRepository.fail({
        runId,
        failureCode: code,
        completedAt: new Date(),
      });
    } catch {
      // Preserve the original classifier or persistence error.
    }
  }
}

function failureCode(error: unknown): TriageFailureCode {
  if (error instanceof ClassifierTimeoutError) return "TIMEOUT";
  if (error instanceof ClassifierUnavailableError) return "UNAVAILABLE";
  if (error instanceof ClassifierInvalidResponseError) return "INVALID_RESPONSE";
  return "UNEXPECTED";
}
