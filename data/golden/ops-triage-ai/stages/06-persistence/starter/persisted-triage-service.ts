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
    // TODO 1: gere runId e registre o início (runs.start) ANTES de classificar.
    // TODO 2: sucesso → gere decisionId, runs.complete(...) e devolva { decisionId, decision }.
    // TODO 3: erro → runs.fail com o failureCode certo e RELANCE o erro original.
    //         Se runs.fail também falhar, o erro original é que deve chegar a quem chamou.
    const decision = await this.triage.execute(input);
    return { decisionId: crypto.randomUUID(), decision };
  }
}

function failureCode(error: unknown): TriageFailureCode {
  if (error instanceof ClassifierTimeoutError) return "TIMEOUT";
  if (error instanceof ClassifierUnavailableError) return "UNAVAILABLE";
  if (error instanceof ClassifierInvalidResponseError) return "INVALID_RESPONSE";
  return "UNEXPECTED";
}
