import type { Logger } from "../obs/logger.ts";
import type { Candidate, Decision, EvaluationResult, Measurement, Mission, Organism } from "./domain.ts";
import { notRun } from "./evaluators.ts";
import type { CandidateWorkspace, Evaluator, MutationProposal, MutationProvider, TelemetrySource } from "./ports.ts";
import { decide, measurementsOf, missionProgress } from "./selection.ts";
import type { HabitatStore } from "./store.ts";

export type HabitatLogger = Logger;

export type HabitatDeps = {
  store: HabitatStore;
  organism: Organism;
  mission: Mission;
  workspace: CandidateWorkspace;
  /** Runs first; when it fails nothing else executes (the candidate touched what it must not). */
  pathPolicy: Evaluator;
  evaluators: Evaluator[];
  mutations: MutationProvider;
  telemetry?: TelemetrySource;
  /** Current revision of the organism (what is deployed): the baseline of new observations. */
  baselineRevision: () => Promise<string>;
  logger: HabitatLogger;
};

export class HabitatBusyError extends Error {
  override readonly name = "HabitatBusyError";
}

/**
 * The closed loop: observe the baseline, turn proposals into isolated candidates,
 * evaluate them independently, decide, and wait for a human to promote.
 * One job at a time: evaluations are heavy and must not interleave.
 */
export class Habitat {
  readonly mission: Mission;
  private busy: string | null = null;

  constructor(private readonly deps: HabitatDeps) {
    this.mission = deps.store.ensureMission(deps.mission);
  }

  get running(): string | null {
    return this.busy;
  }

  async observeBaseline(): Promise<{ observationId: string; evaluations: EvaluationResult[] }> {
    return this.exclusive("observe", async () => {
      const { store } = this.deps;
      const revision = await this.deps.baselineRevision();
      const observation = store.addObservation(this.mission.id, revision);
      // The baseline is measured in its own worktree too: the live checkout is never an evaluation target.
      const workspace = await this.deps.workspace.prepare(observation.id, revision);
      const evaluations: EvaluationResult[] = [];
      try {
        for (const evaluator of this.deps.evaluators) {
          const result = await this.safely(evaluator, { dir: workspace.dir, baselineRevision: revision, revision, changes: [] });
          store.addEvaluation("observation", observation.id, result);
          evaluations.push(result);
        }
      } finally {
        await this.deps.workspace.dispose(workspace);
      }
      const telemetry = await this.telemetry();
      store.addEvaluation("observation", observation.id, telemetry);
      evaluations.push(telemetry);
      store.record("observation_recorded", {
        missionId: this.mission.id,
        data: { observationId: observation.id, revision, measurements: evaluations.flatMap((e) => e.measurements).map((m) => `${m.metric}=${m.value ?? m.status}`) },
      });
      this.deps.logger.info("observation_recorded", { observationId: observation.id, revision });
      return { observationId: observation.id, evaluations };
    });
  }

  async proposals(): Promise<MutationProposal[]> {
    return this.deps.mutations.propose();
  }

  /** proposal → isolated candidate → independent evaluation → decision. Never touches the baseline. */
  async evolve(proposalId: string): Promise<{ candidate: Candidate; decision: Decision }> {
    return this.exclusive(`evolve:${proposalId}`, async () => {
      const { store } = this.deps;
      const observation = store.latestObservation(this.mission.id);
      if (!observation) throw new Error("observe the baseline before evaluating candidates");
      const proposal = (await this.deps.mutations.propose()).find((p) => p.id === proposalId);
      if (!proposal) throw new Error(`unknown proposal ${proposalId}`);

      // Candidates of the same baseline form one generation: several may compete against it.
      const candidate = store.addCandidate({
        id: `cand-${crypto.randomUUID().slice(0, 8)}`,
        missionId: this.mission.id,
        proposalId: proposal.id,
        generation: 1,
        parentRevision: observation.revision,
        hypothesis: proposal.hypothesis,
        source: proposal.source,
        claims: proposal.claims ?? null,
      });
      store.record("candidate_proposed", { missionId: this.mission.id, candidateId: candidate.id, data: { proposalId: proposal.id, hypothesis: proposal.hypothesis, source: proposal.source, claims: proposal.claims ?? null } });

      const workspace = await this.deps.workspace.prepare(candidate.id, observation.revision);
      let decision: Decision;
      try {
        let mutated;
        try {
          mutated = await this.deps.workspace.mutate(workspace, proposal.patch, `habitat candidate ${candidate.id}: ${proposal.hypothesis.slice(0, 60)}`);
        } catch (error) {
          store.updateCandidate(candidate.id, { status: "rejected" });
          store.record("candidate_rejected", { missionId: this.mission.id, candidateId: candidate.id, data: { reason: `patch não se aplica à baseline: ${String(error)}` } });
          throw error;
        }
        await this.deps.workspace.retain(candidate.id, mutated.revision);
        store.updateCandidate(candidate.id, { status: "prepared", revision: mutated.revision });
        store.addChanges(candidate.id, mutated.changes);
        store.record("candidate_prepared", { missionId: this.mission.id, candidateId: candidate.id, data: { revision: mutated.revision, files: mutated.changes.map((c) => `${c.status} ${c.path}`) } });

        store.updateCandidate(candidate.id, { status: "evaluating" });
        store.record("candidate_evaluation_started", { missionId: this.mission.id, candidateId: candidate.id });
        const context = { dir: workspace.dir, baselineRevision: observation.revision, revision: mutated.revision, changes: mutated.changes };
        const evaluations: EvaluationResult[] = [];
        const policy = await this.safely(this.deps.pathPolicy, context);
        evaluations.push(policy);
        for (const evaluator of this.deps.evaluators) {
          // A candidate outside its allowed paths may have tampered with tests or evaluators: run none of its code.
          const result = policy.status === "PASS" ? await this.safely(evaluator, context) : notRun(evaluator.id, "não executado: o candidate violou a política de caminhos");
          evaluations.push(result);
        }
        evaluations.forEach((e) => store.addEvaluation("candidate", candidate.id, e));

        decision = decide(this.mission, store.evaluations("observation", observation.id), evaluations);
        store.saveDecision(candidate.id, decision);
        for (const c of decision.constraints.filter((x) => x.status === "FAIL")) {
          store.record("constraint_failed", { missionId: this.mission.id, candidateId: candidate.id, data: { constraint: c.name, severity: c.severity, detail: c.detail } });
        }
        const status = decision.verdict === "INELIGIBLE" ? "ineligible" : decision.verdict === "PROMOTABLE" ? "promotable" : decision.verdict === "WORSE" ? "rejected" : "eligible";
        store.updateCandidate(candidate.id, { status });
        store.record("candidate_evaluation_finished", { missionId: this.mission.id, candidateId: candidate.id, data: { verdict: decision.verdict, reasons: decision.reasons } });
        store.record(status === "promotable" ? "candidate_promotable" : status === "rejected" || status === "ineligible" ? "candidate_rejected" : "candidate_eligible", { missionId: this.mission.id, candidateId: candidate.id, data: { verdict: decision.verdict } });
        this.deps.logger.info("candidate_evaluated", { candidateId: candidate.id, verdict: decision.verdict });
      } finally {
        await this.deps.workspace.dispose(workspace);
      }
      const final = store.candidate(candidate.id);
      if (!final) throw new Error("candidate vanished");
      return { candidate: final, decision };
    });
  }

  /**
   * A human decision. Promotion never deploys and never touches the baseline branch:
   * it publishes the candidate revision as a branch for the human to merge.
   */
  async promote(candidateId: string, by: string, publish: (branch: string, revision: string) => Promise<void>): Promise<string> {
    const { store } = this.deps;
    const candidate = store.candidate(candidateId);
    if (!candidate) throw new Error(`unknown candidate ${candidateId}`);
    if (candidate.status !== "promotable" || !candidate.revision) throw new Error(`candidate ${candidateId} is ${candidate.status}, not promotable`);
    const branch = `habitat/${candidate.id}`;
    await publish(branch, candidate.revision);
    store.updateCandidate(candidateId, { status: "promoted" });
    store.record("candidate_promoted", { missionId: this.mission.id, candidateId, data: { by, branch, revision: candidate.revision } });
    return branch;
  }

  /** Where the organism stands: the latest baseline observation against the desired state. */
  progress() {
    const observation = this.deps.store.latestObservation(this.mission.id);
    const measurements = observation ? measurementsOf(this.deps.store.evaluations("observation", observation.id)) : new Map<string, Measurement>();
    return { observation, progress: missionProgress(this.mission, measurements) };
  }

  private async telemetry(): Promise<EvaluationResult> {
    if (!this.deps.telemetry) return notRun("telemetry", "nenhuma fonte de telemetria configurada");
    const started = performance.now();
    const measurements = await this.deps.telemetry.measure();
    const insufficient = measurements.filter((m) => m.status === "INSUFFICIENT_DATA").length;
    return {
      evaluatorId: "telemetry",
      // Telemetry informs the mission; it is not a gate, so it reports what it saw rather than PASS/FAIL.
      status: "PASS",
      measurements,
      evidence: [{ kind: "report", summary: `${measurements.length} métricas de uso real, ${insufficient} sem dados suficientes` }],
      durationMs: Math.round(performance.now() - started),
      errors: [],
    };
  }

  /** An evaluator crash is a FAIL with the error as evidence, never an exception that skips the decision. */
  private async safely(evaluator: Evaluator, context: Parameters<Evaluator["evaluate"]>[0]): Promise<EvaluationResult> {
    try {
      return await evaluator.evaluate(context);
    } catch (error) {
      this.deps.logger.error("evaluator_crashed", { evaluatorId: evaluator.id, error: String(error) });
      return { evaluatorId: evaluator.id, status: "FAIL", measurements: [], evidence: [{ kind: "note", summary: "o avaliador falhou ao executar", detail: String(error) }], durationMs: 0, errors: [String(error)] };
    }
  }

  private async exclusive<T>(job: string, run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new HabitatBusyError(`Habitat is busy with ${this.busy}`);
    this.busy = job;
    try {
      return await run();
    } finally {
      this.busy = null;
    }
  }
}
