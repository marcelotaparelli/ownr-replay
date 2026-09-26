import { ClassifierInvalidResponseError, ClassifierTimeoutError, ClassifierUnavailableError } from "./classifier-errors.ts";
import type { TriageFailureCode, TriageRunRepository } from "./triage-persistence.ts";
import type { TriageDecision } from "./triage-decision.ts";
import type { TicketInput } from "./triage.ts";

// O que o serviço precisa do caso de uso da Stage 5.
export interface TriageUseCase {
  execute(input: TicketInput): Promise<TriageDecision>;
}

export class PersistedTriageService {
  constructor(
    private readonly triage: TriageUseCase,
    private readonly runs: TriageRunRepository,
  ) {}

  async execute(input: TicketInput): Promise<{ decisionId: string; decision: TriageDecision }> {
    const runId = crypto.randomUUID();
    // Registrar ANTES de classificar: uma execução que morre no meio deixa rastro.
    await this.runs.start({ runId, ticketId: crypto.randomUUID(), ticket: input });
    try {
      const decision = await this.triage.execute(input);
      const decisionId = crypto.randomUUID();
      await this.runs.complete({ runId, decisionId, decision, completedAt: new Date() });
      return { decisionId, decision };
    } catch (error) {
      await this.markFailed(runId, failureCode(error));
      throw error;
    }
  }

  private async markFailed(runId: string, failureCode: TriageFailureCode): Promise<void> {
    try {
      await this.runs.fail({ runId, failureCode, completedAt: new Date() });
    } catch {
      // Falhar ao registrar a falha não pode esconder o erro original.
    }
  }
}

function failureCode(error: unknown): TriageFailureCode {
  if (error instanceof ClassifierTimeoutError) return "TIMEOUT";
  if (error instanceof ClassifierUnavailableError) return "UNAVAILABLE";
  if (error instanceof ClassifierInvalidResponseError) return "INVALID_RESPONSE";
  return "UNEXPECTED";
}
