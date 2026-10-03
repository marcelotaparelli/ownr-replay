import { z } from "zod";
import { resolveNode, type RepositoryIndex } from "../services/code-map.ts";
import { previousVersions, stageCodeHighlights } from "../domain/line-diff.ts";
import type { Repository } from "../db/repository.ts";
import { outline, type Journey } from "../domain/journey.ts";
import { FROM_SCRATCH, LearningGoal } from "../domain/learning-goal.ts";
import { AttemptInput, ClientEvent, KnowledgeLevel, LearnerId, ProgressUpdate } from "../domain/progress.ts";
import { CodeFile, type Stage } from "../domain/stage.ts";
import { TutorRequest } from "../domain/tutor.ts";
import type { Logger } from "../obs/logger.ts";
import type { Metrics } from "../obs/metrics.ts";
import { ModuleError, completeExercise, prepareExercise } from "../sandbox/modules.ts";
import { TypecheckBusyError, type TypeChecker, type TypeDiagnostic } from "../sandbox/typecheck.ts";
import type { SandboxRunner } from "../sandbox/runner.ts";
import { parseGithubRepoUrl, type GithubRepo } from "../services/repo-url.ts";
import { IngestError, type IngestErrorCode, type SnapshotIngestor } from "../services/repository-ingest.ts";
import type { FlowIntent } from "../services/flow-discovery.ts";
import { looksLikeTicketFlowGoal } from "../services/request-trace-generation.ts";
import { isModule2Goal, type ModuleGenerationService } from "../services/stage-generation.ts";
import type { TargetedJourneyStore } from "../services/targeted-journey.ts";
import type { TutorService } from "../services/tutor.ts";
import { HttpError, Router, json, readBody } from "./router.ts";

export type ApiDeps = {
  journeys: Journey[];
  repository: Repository;
  tutor: TutorService;
  /** null = development BrowserRunner: the server only prepares modules. */
  sandbox: SandboxRunner | null;
  /** Needed only by stages that teach types; null disables those runs with a clear error. */
  typeChecker: TypeChecker | null;
  logger: Logger;
  metrics: Metrics;
  /** The real repository of each journey at its pinned SHA, indexed (architecture node → code). */
  codeIndexes: Map<string, RepositoryIndex>;
  generation?: ModuleGenerationService;
  targeted?: TargetedJourneyStore;
  /** Repositories served only by generation: an empty journey carrying the repo identity (its index is in codeIndexes). */
  generationBases?: Journey[];
  /** Pins a GitHub repository at its current commit and indexes it; absent = only snapshots already on disk. */
  ingest?: SnapshotIngestor;
};

const INGEST_STATUS: Record<IngestErrorCode, number> = { REPO_NOT_FOUND: 404, LIMIT_EXCEEDED: 422, NO_SUPPORTED_CODE: 422, UNSAFE_PATH: 422, DOWNLOAD_FAILED: 502 };
const repoKey = (repo: GithubRepo): string => `${repo.owner}/${repo.name}`.toLowerCase();

const RunRequest = z.strictObject({ files: z.array(CodeFile).min(1).max(10) });
const KnowledgeRequest = z.strictObject({ conceptIds: z.array(z.string().max(64)).min(1).max(50), state: KnowledgeLevel });
const CreateJourneyRequest = z.strictObject({ repoUrl: z.string().max(200), goal: LearningGoal.default(FROM_SCRATCH) });

const RUN_TIMEOUT_MS = 3_000;
const MAX_SOURCE_BYTES = 64 * 1024;
const TUTOR_LIMIT_PER_MINUTE = 20;

export function createApi(deps: ApiDeps): Router {
  const { journeys, repository, logger, metrics } = deps;
  const journeyById = new Map(journeys.map((journey) => [journey.id, journey]));
  const stageById = new Map(
    journeys.flatMap((journey) => journey.stages.map((stage) => [stage.id, { journey, stage }] as const)),
  );
  // Repositories curated by hand (data/golden): never replaced by an ingested snapshot.
  const authoredRepos = new Set(journeys.filter((j) => !deps.generationBases?.some((base) => repoKey(base.repo) === repoKey(j.repo))).map((j) => repoKey(j.repo)));
  const tutorWindow = new Map<string, { windowStart: number; count: number }>();
  const publishModule = async (journey: Journey, moduleId: string, goal: string): Promise<Journey> => {
    const index = deps.codeIndexes.get(journey.id);
    if (!deps.generation || !index) throw new HttpError(503, "GENERATION_UNAVAILABLE", "Geração indisponível neste servidor.");
    const generated = await deps.generation.generate(journey, moduleId, goal, index);
    Object.assign(journey, generated);
    for (const [id, value] of stageById) if (value.journey === journey) stageById.delete(id);
    for (const stage of journey.stages) stageById.set(stage.id, { journey, stage });
    logger.info("module_generated", { journeyId: journey.id, moduleId, stages: journey.modules.find((m) => m.id === moduleId)?.stageIds.length ?? 0 });
    return journey;
  };

  /** Pins the repository's current commit, serving it from disk when already there. Failures are explicit, never a fallback. */
  const ensureSnapshot = async (repo: GithubRepo, goal: LearningGoal, learnerId: string | null): Promise<Journey> => {
    const started = performance.now();
    try {
      const { source, cached } = await deps.ingest!.ensure(repo);
      const { base, index } = source;
      if (!deps.generationBases?.some((known) => known.id === base.id)) deps.generationBases?.push(base);
      deps.codeIndexes.set(base.id, index);
      const durationMs = Math.round(performance.now() - started);
      if (!cached) metrics.observe("snapshot_ingest_duration", durationMs);
      logger.info(cached ? "snapshot_reused" : "snapshot_ingested", { repo: `${repo.owner}/${repo.name}`, sha: base.repo.sha, files: index.files.size, durationMs });
      return base;
    } catch (error) {
      if (!(error instanceof IngestError)) throw error;
      repository.recordJourneyRequest({ learnerId, owner: repo.owner, name: repo.name, goal, served: false });
      logger.error("snapshot_failed", { repo: `${repo.owner}/${repo.name}`, code: error.code });
      throw new HttpError(INGEST_STATUS[error.code], error.code, error.message);
    }
  };

  const findJourney = (id: string | undefined): Journey => {
    const journey = id ? journeyById.get(id) : undefined;
    if (!journey) throw new HttpError(404, "JOURNEY_NOT_FOUND", "Jornada não encontrada.");
    return journey;
  };
  const findStage = (id: string | undefined): { journey: Journey; stage: Stage } => {
    const found = id ? stageById.get(id) : undefined;
    if (!found) throw new HttpError(404, "STAGE_NOT_FOUND", "Stage não encontrada.");
    return found;
  };
  const learner = (req: Request): string => {
    const parsed = LearnerId.safeParse(req.headers.get("x-learner-id"));
    if (!parsed.success) throw new HttpError(401, "MISSING_LEARNER_ID", "Cabeçalho x-learner-id ausente ou inválido.");
    return parsed.data;
  };

  return new Router()
    .on("GET", "/healthz", () => json({ status: "ok" }))
    .on("GET", "/api/metrics", () => json(metrics.snapshot()))

    .on("GET", "/api/journeys", () =>
      json(
        journeys.map((j) => ({
          id: j.id,
          title: j.title,
          description: j.description,
          repo: j.repo,
          status: j.status,
          stageCount: j.stages.length,
        })),
      ),
    )
    .on("POST", "/api/journeys", async (req) => {
      const { repoUrl, goal } = await readBody(req, CreateJourneyRequest);
      const repo = parseGithubRepoUrl(repoUrl);
      if (!repo) throw new HttpError(422, "INVALID_REPO_URL", "Use uma URL pública no formato https://github.com/owner/repo.");
      const parsedLearner = LearnerId.safeParse(req.headers.get("x-learner-id"));
      const learnerId = parsedLearner.success ? parsedLearner.data : null;
      const isRepo = (j: Journey): boolean => repoKey(j.repo) === repoKey(repo);
      // A repository without a hand-authored journey is pinned at its current commit on demand; one
      // that has a snapshot (committed or ingested before) is reused when that commit is still current.
      const wantsFlow = Boolean((goal.kind === "trace_request" && goal.target) || (goal.kind === "other" && goal.note));
      const needsSnapshot = deps.ingest !== undefined && wantsFlow && !authoredRepos.has(repoKey(repo));
      const generationBase = needsSnapshot ? await ensureSnapshot(repo, goal, learnerId) : deps.generationBases?.find(isRepo);
      // Journeys of other commits of the same repository stay where they are, bound to their own sha.
      const sameRepo = journeys.filter((j) => isRepo(j) && (!generationBase || j.repo.sha === generationBase.repo.sha));
      // "other" is free text too: when it reads like the supported ticket-flow trace, treat it as one
      // instead of forcing the learner to know which radio button maps to the generator that already exists.
      // The intent travels with the text: a traced request and a free technical goal are planned differently.
      // A generation-only repository has no ticket-flow trace to recognize, so its "other" stays a free goal;
      // elsewhere an "other" that reads like the ticket flow is that trace (see above).
      const flowGoal: { intent: FlowIntent; text: string } | undefined =
        goal.kind === "trace_request" && goal.target ? { intent: "trace_request", text: goal.target }
        : goal.kind === "other" && goal.note && generationBase ? { intent: "other", text: goal.note }
        : goal.kind === "other" && goal.note && looksLikeTicketFlowGoal(goal.note) ? { intent: "trace_request", text: goal.note }
        : undefined;
      const match = sameRepo.find((j) =>
        flowGoal !== undefined
          ? j.goal.kind === flowGoal.intent && (flowGoal.intent === "trace_request" ? j.goal.target : j.goal.note)?.toLowerCase() === flowGoal.text.toLowerCase()
          : j.goal.kind === goal.kind && (goal.kind !== "specific_part" || j.goal.target?.toLowerCase() === goal.target?.toLowerCase()),
      );
      const journey = sameRepo.find((item) => item.goal.kind === "from_scratch") ?? generationBase;
      const target = goal.kind === "specific_part" ? goal.target?.trim().toLowerCase() : undefined;
      const candidateModule = journey?.modules.find((module) => {
        const stages = journey.stages.filter((stage) => stage.moduleId === module.id);
        if (!stages.length || !target) return false;
        if (module.id === "m2" && isModule2Goal(target)) return true;
        return stages.some((stage) => stage.originalCodeRefs.some((ref) => ref.symbol.toLowerCase() === target || ref.path.toLowerCase() === target) ||
          stage.referenceCode.some((file) => file.path.toLowerCase() === target || file.content.toLowerCase().includes(`class ${target} `)));
      });
      const canGenerateTarget = Boolean(target && candidateModule && deps.generation && deps.targeted);
      const canTraceRequest = Boolean(flowGoal && journey && deps.generation && deps.targeted && deps.codeIndexes.get(journey.id));
      repository.recordJourneyRequest({ learnerId, owner: repo.owner, name: repo.name, goal, served: Boolean(match || canGenerateTarget || canTraceRequest) });
      logger.info("journey_requested", { repo: `${repo.owner}/${repo.name}`, goal: goal.kind, served: Boolean(match || canGenerateTarget || canTraceRequest) });
      if (match) return json({ id: match.id, status: match.status, ...(match.goal.kind === "specific_part" || flowGoal !== undefined ? { startOrder: 1 } : {}) });
      if (canTraceRequest && journey && flowGoal && deps.generation && deps.targeted) {
        try {
          const index = deps.codeIndexes.get(journey.id)!;
          const route = deps.targeted.saveRoute(journey, await deps.generation.generateRequestJourney(journey, flowGoal.text, index, flowGoal.intent));
          journeys.push(route);
          journeyById.set(route.id, route);
          for (const stage of route.stages) stageById.set(stage.id, { journey: route, stage });
          deps.codeIndexes.set(route.id, index);
          return json({ id: route.id, status: route.status, startOrder: 1 });
        } catch (error) {
          // A generation base is not a journey a learner can open, so it is never offered as a fallback.
          return json({ error: { code: "GENERATION_FAILED", message: error instanceof Error ? error.message : "Falha ao gerar o fluxo." }, ...(journey === generationBase ? {} : { fallback: { id: journey.id } }) }, 422);
        }
      }
      if (canGenerateTarget && candidateModule && journey && goal.target) {
        try {
          if (candidateModule.stageIds.length === 1) await publishModule(journey, candidateModule.id, goal.target);
          const targeted = deps.targeted!.save(journey, candidateModule.id, goal.target);
          journeys.push(targeted);
          journeyById.set(targeted.id, targeted);
          for (const stage of targeted.stages) stageById.set(stage.id, { journey: targeted, stage });
          const index = deps.codeIndexes.get(journey.id);
          if (index) deps.codeIndexes.set(targeted.id, index);
          return json({ id: targeted.id, status: targeted.status, startOrder: 1 });
        } catch (error) {
          return json({ error: { code: "GENERATION_FAILED", message: error instanceof Error ? error.message : "Falha ao gerar o módulo." }, fallback: { id: journey.id } }, 422);
        }
      }
      if (generationBase) {
        throw new HttpError(501, "GOAL_NOT_AVAILABLE", `Para ${repo.owner}/${repo.name}, descreva um fluxo ou objetivo técnico em “Rastrear uma requisição” ou “Outro”, por exemplo: “Quero entender como uma transação é persistida”.`);
      }
      // plan(repository, goal) → journey is a later phase (Planner). Be explicit about what exists today.
      const fallback = sameRepo[0];
      if (fallback) {
        return json(
          { error: { code: "GOAL_NOT_AVAILABLE", message: "Jornadas direcionadas a esse objetivo ainda não são geradas. Registramos o seu pedido. Por enquanto, este repositório tem a jornada “Aprender o projeto do zero”." }, fallback: { id: fallback.id } },
          501,
        );
      }
      throw new HttpError(501, "GENERATION_NOT_AVAILABLE", `Geração automática para ${repo.owner}/${repo.name} ainda não está disponível.`);
    })
    .on("GET", "/api/journeys/:id", (_req, params) => json(outline(findJourney(params.id))))
    .on("POST", "/api/journeys/:id/modules/:moduleId/generate", async (req, params) => {
      const journey = findJourney(params.id);
      const moduleId = params.moduleId ?? "";
      const module = journey.modules.find((m) => m.id === moduleId);
      if (!module) throw new HttpError(404, "MODULE_NOT_FOUND", "Módulo não encontrado.");
      if (module.stageIds.length > 1) return json(outline(journey));
      const body = await readBody(req, z.strictObject({ goal: z.string().min(1).max(200) }));
      try {
        await publishModule(journey, moduleId, body.goal);
        return json(outline(journey));
      } catch (error) {
        logger.error("module_generation_failed", { journeyId: journey.id, moduleId, error: error instanceof Error ? error.message : String(error) });
        throw new HttpError(422, "GENERATION_FAILED", error instanceof Error ? error.message : "Falha ao gerar o módulo.");
      }
    })
    .on("GET", "/api/journeys/:id/stages", (_req, params) => json(outline(findJourney(params.id)).stages))
    .on("GET", "/api/journeys/:id/events", (_req, params) => {
      const journey = findJourney(params.id);
      // Generation progress stream; hand-authored journeys are ready immediately.
      const body = `event: status\ndata: ${JSON.stringify({ status: journey.status })}\n\n`;
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      });
    })
    .on("GET", "/api/journeys/:id/progress", (req, params) => {
      const journey = findJourney(params.id);
      const learnerId = learner(req);
      return json({
        stages: repository.listProgress(learnerId, journey.id),
        knowledge: repository.listKnowledge(learnerId),
      });
    })
    .on("POST", "/api/journeys/:id/knowledge", async (req, params) => {
      const journey = findJourney(params.id);
      const learnerId = learner(req);
      const { conceptIds, state } = await readBody(req, KnowledgeRequest);
      const valid = new Set(journey.concepts.map((c) => c.id));
      const unknown = conceptIds.filter((id) => !valid.has(id));
      if (unknown.length) throw new HttpError(422, "UNKNOWN_CONCEPT", "Conceito desconhecido nesta jornada.");
      repository.setKnowledge(learnerId, conceptIds, state);
      repository.appendEvent({ learnerId, journeyId: journey.id, stageId: null, type: "concept_known", data: { conceptIds: conceptIds.join(","), state } });
      return json({ ok: true });
    })

    .on("GET", "/api/stages/:id", (_req, params) => {
      const { stage, journey } = findStage(params.id);
      // What each shown file looked like before, so every stage can highlight only what changed.
      return json({ ...stage, runner: deps.sandbox ? "docker" : "browser", previousCode: previousVersions(journey.stages, stage.id), codeHighlights: stageCodeHighlights(journey.stages, stage.id) });
    })
    .on("GET", "/api/stages/:id/architecture", (_req, params) => {
      const { stage, journey } = findStage(params.id);
      const index = deps.codeIndexes.get(journey.id) ?? { files: new Map(), declarations: [] };
      // Only the components this stage has already presented: the diagram grows with the journey.
      const nodes = (stage.architecture?.nodes ?? []).map((node) => resolveNode(node, journey, index));
      const paths = new Set(nodes.flatMap((n) => (n.status === "mapped" ? n.options.map((o) => o.path) : [])));
      return json({ repo: journey.repo, nodes, files: Object.fromEntries([...paths].map((p) => [p, index.files.get(p) ?? ""])) });
    })
    .on("GET", "/api/stages/:id/toolbox", (_req, params) => json(findStage(params.id).stage.toolbox))
    .on("POST", "/api/stages/:id/run", async (req, params) => {
      const { stage } = findStage(params.id);
      const learnerId = learner(req);
      const exercise = stage.exercise;
      if (!exercise) throw new HttpError(409, "STAGE_HAS_NO_EXERCISE", "Esta stage não tem exercício.");
      const { files } = await readBody(req, RunRequest);
      const allowed = new Set(exercise.starterFiles.map((f) => f.path));
      if (files.some((f) => !allowed.has(f.path)) || new Set(files.map((f) => f.path)).size !== files.length) {
        throw new HttpError(422, "UNEXPECTED_FILE", "Só os arquivos do exercício podem ser enviados.");
      }
      if (files.reduce((n, f) => n + f.content.length, 0) > MAX_SOURCE_BYTES) {
        throw new HttpError(413, "SOURCE_TOO_LARGE", "Código grande demais para esta stage.");
      }
      let modules;
      try {
        modules = await prepareExercise(exercise, files);
      } catch (error) {
        if (!(error instanceof ModuleError)) throw error;
        // The phase travels as the error code, so the learner sees where it failed.
        throw new HttpError(422, error.phase === "transpilation" ? "TRANSPILATION_FAILED" : "MODULE_REJECTED", error.message);
      }
      // Types taught in this stage are verified for real, before anything runs.
      if (exercise.typecheck) {
        const diagnostics = await typecheck([...completeExercise(exercise, files), ...exercise.typecheck.files], stage.id);
        if (diagnostics.length > 0) return json({ mode: "typecheck", diagnostics });
      }
      const typecheckPassed = exercise.typecheck ? { typecheck: "passed" as const } : {};
      if (!deps.sandbox) return json({ mode: "browser", ...typecheckPassed, ...modules });

      const started = performance.now();
      const result = await deps.sandbox.run({ modules, timeoutMs: RUN_TIMEOUT_MS });
      metrics.observe("sandbox_duration", performance.now() - started);
      if (result.timedOut) metrics.increment("sandbox_timeout_total");
      recordAttempt(learnerId, stage.id, "docker", result);
      return json({ mode: "server", ...typecheckPassed, result });
    })
    .on("POST", "/api/stages/:id/attempts", async (req, params) => {
      const { journey, stage } = findStage(params.id);
      const learnerId = learner(req);
      if (deps.sandbox) throw new HttpError(409, "ATTEMPTS_RECORDED_BY_SERVER", "Com o sandbox server-side, tentativas são registradas pelo servidor.");
      const { result } = await readBody(req, AttemptInput);
      const firstPass = recordAttempt(learnerId, stage.id, "browser", result, journey.id);
      return json({ ok: true, firstPass });
    })
    .on("POST", "/api/stages/:id/tutor", async (req, params) => {
      const { journey, stage } = findStage(params.id);
      const learnerId = learner(req);
      rateLimitTutor(learnerId);
      const request = await readBody(req, TutorRequest);
      return json(await deps.tutor.ask(learnerId, journey, stage, request));
    })
    .on("POST", "/api/stages/:id/progress", async (req, params) => {
      const { journey, stage } = findStage(params.id);
      const learnerId = learner(req);
      const update = await readBody(req, ProgressUpdate);
      repository.saveProgress({
        learnerId,
        journeyId: journey.id,
        stageId: stage.id,
        status: update.status,
        anchor: update.anchor ?? null,
        timeSpentMs: update.timeSpentMs ?? 0,
      });
      if (update.knownConcepts?.length) {
        const valid = new Set(journey.concepts.map((c) => c.id));
        repository.setKnowledge(learnerId, update.knownConcepts.filter((id) => valid.has(id)), "known");
      }
      repository.appendEvent({
        learnerId,
        journeyId: journey.id,
        stageId: stage.id,
        type: "stage_status_changed",
        data: { status: update.status, timeSpentMs: update.timeSpentMs ?? 0 },
      });
      if (update.status === "completed") metrics.increment("stage_completed_total");
      if (update.status === "skipped_known") metrics.increment("stage_skipped_known_total");
      logger.info("stage_progress", { stageId: stage.id, status: update.status });
      return json({ ok: true });
    })
    .on("POST", "/api/stages/:id/events", async (req, params) => {
      const { journey, stage } = findStage(params.id);
      const learnerId = learner(req);
      const event = await readBody(req, ClientEvent);
      repository.appendEvent({ learnerId, journeyId: journey.id, stageId: stage.id, type: event.type, ...(event.data ? { data: event.data } : {}) });
      return json({ ok: true });
    });

  function recordAttempt(
    learnerId: string,
    stageId: string,
    runner: string,
    result: z.infer<typeof AttemptInput>["result"],
    journeyId = stageById.get(stageId)?.journey.id ?? "",
  ): boolean {
    const passed = result.tests.filter((t) => t.passed).length;
    const total = result.tests.length;
    const previous = repository.recordAttempt({ learnerId, stageId, runner, passed, total, latencyMs: result.latencyMs });
    const firstPass = previous === 0 && total > 0 && passed === total;
    repository.appendEvent({
      learnerId,
      journeyId,
      stageId,
      type: "stage_run",
      data: { runner, passed, total, latencyMs: Math.round(result.latencyMs), firstPass },
    });
    logger.info("stage_run", { stageId, runner, passed: passed === total, latencyMs: Math.round(result.latencyMs) });
    return firstPass;
  }

  async function typecheck(files: CodeFile[], stageId: string): Promise<TypeDiagnostic[]> {
    if (!deps.typeChecker) throw new HttpError(503, "TYPECHECK_UNAVAILABLE", "Verificação de tipos indisponível no servidor.");
    const started = performance.now();
    try {
      const diagnostics = await deps.typeChecker.check(files);
      const ms = performance.now() - started;
      metrics.observe("typecheck_duration", ms);
      logger.info("typecheck", { stageId, errors: diagnostics.length, durationMs: Math.round(ms) });
      return diagnostics;
    } catch (error) {
      if (error instanceof TypecheckBusyError) throw new HttpError(429, "TYPECHECK_BUSY", "Muitas verificações ao mesmo tempo; tente em alguns segundos.");
      throw error;
    }
  }

  function rateLimitTutor(learnerId: string): void {
    const now = Date.now();
    const current = tutorWindow.get(learnerId);
    if (!current || now - current.windowStart > 60_000) {
      tutorWindow.set(learnerId, { windowStart: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > TUTOR_LIMIT_PER_MINUTE) throw new HttpError(429, "TUTOR_RATE_LIMITED", "Muitas perguntas em sequência; tente em alguns segundos.");
  }
}
