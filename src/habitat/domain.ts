import { z } from "zod";

/**
 * OWNR Habitat domain. The software is the evolving object: an Organism has a Mission
 * (desired measurable state), an Envelope it must never leave, and Candidates whose
 * fate is decided by independent evaluation — never by whoever produced them.
 */

// ---------------------------------------------------------------- measurements & checks

/** PASS/FAIL are verdicts of a check that ran; NOT_RUN means no evidence either way. */
export type CheckStatus = "PASS" | "FAIL" | "NOT_RUN";

export type Measurement = {
  metric: string;
  /** null when there is not enough data to state a value. */
  value: number | null;
  status: "MEASURED" | "INSUFFICIENT_DATA";
  unit?: string;
  /** For telemetry: how many observations the value rests on, and over which window. */
  sampleSize?: number;
  window?: string;
  note?: string;
};

export type Evidence = { kind: "command" | "files" | "report" | "note"; summary: string; detail?: string };

export type EvaluationResult = {
  evaluatorId: string;
  status: CheckStatus;
  measurements: Measurement[];
  evidence: Evidence[];
  durationMs: number;
  errors: string[];
};

// ---------------------------------------------------------------- mission, envelope, fitness

export const Operator = z.enum(["<=", ">=", "=="]);
export type Operator = z.infer<typeof Operator>;

export const DesiredMetric = z.strictObject({
  metric: z.string().min(1),
  label: z.string().min(1),
  operator: Operator,
  target: z.number(),
  unit: z.string().optional(),
  /** Telemetry-based targets need enough data before anyone may claim them. */
  minSampleSize: z.number().int().positive().optional(),
  window: z.string().optional(),
});
export type DesiredMetric = z.infer<typeof DesiredMetric>;

export const Constraint = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  severity: z.enum(["hard", "soft"]),
  evaluatorId: z.string().min(1),
  /** Without a metric the constraint follows the evaluator status; with one, the measurement must satisfy it. */
  metric: z.string().optional(),
  operator: Operator.optional(),
  threshold: z.number().optional(),
});
export type Constraint = z.infer<typeof Constraint>;

export const Envelope = z.strictObject({
  id: z.string().min(1),
  constraints: z.array(Constraint).min(1),
  /** Properties nobody checks yet — shown as NOT_RUN, never as passing. */
  uncovered: z.array(z.strictObject({ name: z.string(), reason: z.string() })),
});
export type Envelope = z.infer<typeof Envelope>;

export const Objective = z.strictObject({
  metric: z.string().min(1),
  label: z.string().min(1),
  direction: z.enum(["minimize", "maximize"]),
});
export type Objective = z.infer<typeof Objective>;

/** Counter-metrics: an objective only counts if these still hold (anti-Goodhart). */
export const Guard = z.strictObject({
  metric: z.string().min(1),
  label: z.string().min(1),
  operator: Operator,
  threshold: z.number(),
  reason: z.string().min(1),
});
export type Guard = z.infer<typeof Guard>;

export const Fitness = z.strictObject({ objectives: z.array(Objective).min(1), guards: z.array(Guard) });
export type Fitness = z.infer<typeof Fitness>;

export const Mission = z.strictObject({
  id: z.string().min(1),
  organismId: z.string().min(1),
  objective: z.string().min(1),
  desiredState: z.array(DesiredMetric).min(1),
  fitness: Fitness,
  envelope: Envelope,
  status: z.enum(["draft", "active", "paused", "reached", "failed"]),
});
export type Mission = z.infer<typeof Mission>;

export type Organism = {
  id: string;
  name: string;
  /** Git repository holding the organism (the control plane never evaluates in place). */
  repositoryPath: string;
  /** Paths candidates may change; everything else (tests, evaluators, Habitat itself) is protected. */
  allowedPaths: string[];
};

// ---------------------------------------------------------------- candidates & decisions

export type CandidateStatus = "proposed" | "prepared" | "evaluating" | "ineligible" | "eligible" | "promotable" | "promoted" | "rejected";

export type CandidateSource = { kind: "manual" | "llm" | "rule" | "search"; author: string };

export type Candidate = {
  id: string;
  missionId: string;
  proposalId: string;
  generation: number;
  parentRevision: string;
  revision: string | null;
  hypothesis: string;
  source: CandidateSource;
  /** What the producer said about its own change. Information, never evidence. */
  claims: string | null;
  status: CandidateStatus;
  createdAt: number;
};

export type FileChange = { path: string; status: string; oldMode: string; newMode: string };

export type Verdict = "INELIGIBLE" | "WORSE" | "NEUTRAL" | "BETTER" | "PROMOTABLE";

export type ConstraintResult = { constraintId: string; name: string; severity: "hard" | "soft"; status: CheckStatus; detail: string };

export type MetricComparison = {
  metric: string;
  label: string;
  direction: "minimize" | "maximize";
  baseline: number | null;
  candidate: number | null;
  outcome: "improved" | "worse" | "unchanged" | "unknown";
};

export type GuardResult = Guard & { value: number | null; status: CheckStatus };

export type Decision = {
  verdict: Verdict;
  constraints: ConstraintResult[];
  comparisons: MetricComparison[];
  guards: GuardResult[];
  /** Every reason points at evidence (a constraint, a comparison or a guard). */
  reasons: string[];
};

export type DesiredStatus = DesiredMetric & { value: number | null; sampleSize?: number; status: "MET" | "NOT_MET" | "INSUFFICIENT_DATA" };
