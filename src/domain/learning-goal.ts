import { z } from "zod";
import type { RepositorySnapshot } from "./journey.ts";

/**
 * What the developer wants to understand. A journey is planned from the repository AND
 * this goal: "learn everything" and "understand HybridPolicy" are different journeys.
 */
export const LearningGoalKind = z.enum([
  "from_scratch",
  "main_flow",
  "trace_request",
  "specific_part",
  "architecture_why",
  "topic",
  "other",
]);
export type LearningGoalKind = z.infer<typeof LearningGoalKind>;

export const LearningTopic = z.enum(["persistence", "security", "tests", "integrations"]);
export type LearningTopic = z.infer<typeof LearningTopic>;

export const LearningGoal = z
  .strictObject({
    kind: LearningGoalKind,
    /** A file, class or function (specific_part) — or the request to trace. */
    target: z.string().trim().min(1).max(120).optional(),
    topic: LearningTopic.optional(),
    /** Free text for "other". */
    note: z.string().trim().min(1).max(300).optional(),
  })
  .superRefine((goal, ctx) => {
    if (goal.kind === "specific_part" && !goal.target) ctx.addIssue({ code: "custom", path: ["target"], message: "diga qual parte" });
    if (goal.kind === "topic" && !goal.topic) ctx.addIssue({ code: "custom", path: ["topic"], message: "escolha um tema" });
    if (goal.kind === "other" && !goal.note) ctx.addIssue({ code: "custom", path: ["note"], message: "descreva o objetivo" });
  });
export type LearningGoal = z.infer<typeof LearningGoal>;

/**
 * The input of the future Planner: plan(repository, learningGoal) → journey.
 * Only the contract exists today; hand-authored journeys declare the goal they serve.
 */
export type PlanRequest = { repository: RepositorySnapshot; goal: LearningGoal };

export const FROM_SCRATCH: LearningGoal = { kind: "from_scratch" };
