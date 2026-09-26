import { z } from "zod";

export const StageStatus = z.enum(["not_started", "in_progress", "completed", "skipped", "skipped_known"]);
export type StageStatus = z.infer<typeof StageStatus>;

export const KnowledgeLevel = z.enum(["unknown", "learning", "known", "mastered"]);
export type KnowledgeLevel = z.infer<typeof KnowledgeLevel>;

/** Learners are anonymous for now: a client-generated id. */
export const LearnerId = z.string().regex(/^[a-zA-Z0-9-]{8,64}$/);

export type StageProgress = {
  learnerId: string;
  stageId: string;
  status: StageStatus;
  /** Last section the learner was looking at, for instant resume. */
  anchor: string | null;
  timeSpentMs: number;
  updatedAt: number;
};

export type KnowledgeState = { conceptId: string; state: KnowledgeLevel };

export const ProgressUpdate = z.strictObject({
  status: StageStatus,
  anchor: z.string().max(80).optional(),
  timeSpentMs: z.number().int().min(0).max(86_400_000).optional(),
  /** Concepts the learner declared as known (Fast Path). */
  knownConcepts: z.array(z.string().max(64)).max(50).optional(),
});
export type ProgressUpdate = z.infer<typeof ProgressUpdate>;

export const TestOutcome = z.strictObject({
  name: z.string().max(200),
  passed: z.boolean(),
  error: z.string().max(2_000).optional(),
});

export const RunResult = z.strictObject({
  stdout: z.string().max(20_000),
  stderr: z.string().max(20_000).optional(),
  latencyMs: z.number().min(0),
  timedOut: z.boolean().optional(),
  tests: z.array(TestOutcome).max(100),
});
export type RunResult = z.infer<typeof RunResult>;

export const AttemptInput = z.strictObject({
  runner: z.enum(["browser", "docker"]),
  result: RunResult,
});

/** Append-only learning events: the raw material for pedagogical metrics. */
export type LearningEventType =
  | "stage_opened"
  | "stage_status_changed"
  | "stage_run"
  | "tutor_question"
  | "explanation_depth"
  | "concept_known"
  | "solution_revealed"
  | "checkpoint_revealed"
  | "reconstruct_started";

export const ClientEvent = z.strictObject({
  type: z.enum(["stage_opened", "explanation_depth", "solution_revealed", "checkpoint_revealed", "reconstruct_started"]),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
