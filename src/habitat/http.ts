import { z } from "zod";
import type { Logger } from "../obs/logger.ts";
import { HttpError, Router, json, readBody } from "../http/router.ts";
import type { Organism } from "./domain.ts";
import type { Habitat } from "./evolution.ts";
import type { GitWorktreeWorkspace } from "./git-workspace.ts";
import { missionReached } from "./selection.ts";
import type { HabitatStore } from "./store.ts";

export type HabitatDeps = {
  habitat: Habitat;
  store: HabitatStore;
  workspace: GitWorktreeWorkspace;
  organism: Organism;
  publish: (branch: string, revision: string) => Promise<void>;
  logger: Logger;
};

/** Everything the Cockpit's first screen needs, in one read. */
export async function snapshot({ habitat, store, organism }: Pick<HabitatDeps, "habitat" | "store" | "organism">) {
  const mission = habitat.mission;
  const { observation, progress } = habitat.progress();
  const candidates = store.candidates(mission.id).map((c) => ({ ...c, verdict: store.decision(c.id)?.verdict ?? null }));
  const proposals = (await habitat.proposals()).map(({ patch, ...p }) => ({ ...p, patchLines: patch.split("\n").length, candidates: candidates.filter((c) => c.proposalId === p.id).map((c) => c.id) }));
  return {
    organism: { id: organism.id, name: organism.name, allowedPaths: organism.allowedPaths },
    mission: { ...mission, reached: missionReached(progress) },
    progress,
    baseline: observation ? { ...observation, evaluations: store.evaluations("observation", observation.id) } : null,
    candidates,
    proposals,
    running: habitat.running,
  };
}

const Promote = z.strictObject({ by: z.string().trim().min(2).max(80) });
const Empty = z.strictObject({});

export function createHabitatApi(deps: HabitatDeps): Router {
  const { habitat, store, workspace, logger } = deps;

  /** Long jobs run in the background; the Cockpit polls. Failures become recorder events, never silence. */
  const start = (job: string, run: () => Promise<unknown>): Response => {
    if (habitat.running) throw new HttpError(409, "HABITAT_BUSY", `O Habitat já está executando ${habitat.running}.`);
    run().catch((error: unknown) => {
      logger.error("habitat_job_failed", { job, error: String(error) });
      store.record("job_failed", { missionId: habitat.mission.id, data: { job, error: String(error).slice(0, 500) } });
    });
    return json({ started: job }, 202);
  };

  return new Router()
    .on("GET", "/api/state", async () => json(await snapshot(deps)))
    .on("POST", "/api/baseline/observe", async (req) => {
      await readBody(req, Empty);
      return start("observe", () => habitat.observeBaseline());
    })
    .on("POST", "/api/proposals/:id/candidate", async (req, { id = "" }) => {
      await readBody(req, Empty);
      if (!(await habitat.proposals()).some((p) => p.id === id)) throw new HttpError(404, "UNKNOWN_PROPOSAL", "Proposta não encontrada.");
      if (!store.latestObservation(habitat.mission.id)) throw new HttpError(409, "NO_BASELINE", "Observe a baseline antes de avaliar candidates.");
      return start(`evolve:${id}`, () => habitat.evolve(id));
    })
    .on("GET", "/api/candidates/:id", async (_req, { id = "" }) => {
      const candidate = store.candidate(id);
      if (!candidate) throw new HttpError(404, "UNKNOWN_CANDIDATE", "Candidate não encontrado.");
      const baseline = store.latestObservation(habitat.mission.id);
      return json({
        candidate,
        changes: store.changes(id),
        evaluations: store.evaluations("candidate", id),
        baselineEvaluations: baseline ? store.evaluations("observation", baseline.id) : [],
        decision: store.decision(id) ?? null,
        // The retained revision outlives the worktree: rejected candidates stay inspectable.
        diff: candidate.revision ? (await workspace.diff(candidate.parentRevision, candidate.revision)).slice(0, 200_000) : null,
        events: store.events(500).filter((e) => e.candidateId === id).reverse(),
      });
    })
    .on("POST", "/api/candidates/:id/promote", async (req, { id = "" }) => {
      const { by } = await readBody(req, Promote);
      const candidate = store.candidate(id);
      if (!candidate) throw new HttpError(404, "UNKNOWN_CANDIDATE", "Candidate não encontrado.");
      if (candidate.status !== "promotable") throw new HttpError(409, "NOT_PROMOTABLE", `Candidate está ${candidate.status}; só PROMOTABLE pode ser promovido.`);
      const branch = await habitat.promote(id, by, deps.publish);
      return json({ branch });
    })
    .on("GET", "/api/events", () => json({ events: store.events(300) }));
}
