import type { TriageRunRepository, TriageRunStatus, TriageFailureCode } from "./triage-persistence.ts";
import type { TriageDecision } from "./triage-decision.ts";

type Run = { status: TriageRunStatus; failureCode?: TriageFailureCode; decisionId?: string; decision?: TriageDecision };

// Implementação em memória da porta: suficiente para testes e para rodar sem banco.
export class InMemoryTriageRuns implements TriageRunRepository {
  readonly runs = new Map<string, Run>();
  readonly log: string[] = [];

  async start(input: { runId: string }): Promise<void> {
    this.log.push("start");
    this.runs.set(input.runId, { status: "RUNNING" });
  }

  async complete(input: { runId: string; decisionId: string; decision: TriageDecision }): Promise<void> {
    this.log.push("complete");
    this.runs.set(input.runId, { status: "SUCCEEDED", decisionId: input.decisionId, decision: input.decision });
  }

  async fail(input: { runId: string; failureCode: TriageFailureCode }): Promise<void> {
    this.log.push("fail:" + input.failureCode);
    this.runs.set(input.runId, { status: "FAILED", failureCode: input.failureCode });
  }
}
