import type { StageOutline } from "./journey.ts";
import type { StageStatus } from "./progress.ts";

/**
 * Where am I, how much is left, and how long will it probably take at my pace?
 * Only the mapped route (micro stages and checkpoints) is estimated: chapters that are not yet
 * decomposed have no trustworthy size, so they are counted but never turned into minutes.
 */

export type StageProgressView = { status: StageStatus; timeSpentMs: number };

export type Confidence = "none" | "low" | "medium" | "high";

export type JourneyPlan = {
  /** Effort-weighted share of the mapped route that is owned (completed or declared known), 0–100. */
  percent: number;
  micro: { done: number; total: number };
  checkpoints: { done: number; total: number };
  /** Chapters not yet decomposed into micro stages: outside the percentage and the ETA. */
  unmapped: { done: number; total: number; modules: number };
  pace: {
    /** Completed micro stages whose time is usable as a pace sample. */
    samples: number;
    /** Median minutes per sampled micro stage, as actually spent. */
    medianMinutes: number | null;
    /** Learned multiplier over the authored estimates (1 = as estimated), shrunk toward 1 while samples are few. */
    factor: number;
    skippedKnown: number;
    tooFast: number;
  };
  eta: { minutes: number; low: number; high: number; confidence: Confidence; remainingStages: number };
  /** True when part of the journey is not decomposed, so the ETA covers only the mapped route. */
  partial: boolean;
};

/** Faster than this, a "completed" stage was skimmed, not solved: it counts as progress, not as pace. */
export const MIN_SAMPLE_MS = 15_000;
/** Longer than this, the tab was most likely idle: the sample is capped rather than trusted. */
export const MAX_SAMPLE_MS = 45 * 60_000;
/** How many samples the authored estimate is worth: with few samples the ETA stays close to it. */
const PRIOR_WEIGHT = 3;

const OWNED: StageStatus[] = ["completed", "skipped_known"];

export function planJourney(stages: Pick<StageOutline, "id" | "kind" | "moduleId" | "estimatedMinutes">[], progress: (stageId: string) => StageProgressView): JourneyPlan | null {
  const mapped = stages.filter((s) => s.kind === "micro" || s.kind === "checkpoint");
  if (mapped.length === 0) return null;
  const chapters = stages.filter((s) => s.kind === "chapter");
  const owned = (id: string) => OWNED.includes(progress(id).status);

  const weight = (list: typeof mapped) => list.reduce((n, s) => n + Math.max(1, s.estimatedMinutes), 0);
  const done = mapped.filter((s) => owned(s.id));
  const micro = mapped.filter((s) => s.kind === "micro");
  const checkpoints = mapped.filter((s) => s.kind === "checkpoint");

  // Pace: only micro stages the learner actually solved, with a believable duration.
  const ratios: number[] = [];
  const minutes: number[] = [];
  let tooFast = 0;
  for (const s of micro) {
    const p = progress(s.id);
    if (p.status !== "completed") continue;
    if (p.timeSpentMs < MIN_SAMPLE_MS) {
      tooFast += 1;
      continue;
    }
    const spent = Math.min(p.timeSpentMs, MAX_SAMPLE_MS) / 60_000;
    minutes.push(spent);
    ratios.push(spent / Math.max(1, s.estimatedMinutes));
  }
  const n = ratios.length;
  // Ratios are multiplicative: shrink the median toward 1 in log space.
  const shrink = (ratio: number) => Math.exp((n * Math.log(ratio)) / (n + PRIOR_WEIGHT));
  const factor = n ? shrink(quantile(ratios, 0.5)) : 1;

  const remaining = mapped.filter((s) => !owned(s.id));
  const remainingMinutes = weight(remaining);
  const confidence = confidenceOf(ratios);
  // The spread of a few samples understates uncertainty: widen the quartile band by 1 + 1/√n.
  const widen = 1 + 1 / Math.sqrt(Math.max(n, 1));
  const [low, high] = n >= 3 ? [shrink(quantile(ratios, 0.25)) / widen, shrink(quantile(ratios, 0.75)) * widen] : [factor * 0.5, factor * 2];

  return {
    percent: Math.round((weight(done) / weight(mapped)) * 100),
    micro: { done: micro.filter((s) => owned(s.id)).length, total: micro.length },
    checkpoints: { done: checkpoints.filter((s) => owned(s.id)).length, total: checkpoints.length },
    unmapped: { done: chapters.filter((s) => owned(s.id)).length, total: chapters.length, modules: new Set(chapters.map((s) => s.moduleId)).size },
    pace: {
      samples: n,
      medianMinutes: n ? round1(quantile(minutes, 0.5)) : null,
      factor: round1(factor),
      skippedKnown: mapped.filter((s) => progress(s.id).status === "skipped_known").length,
      tooFast,
    },
    eta: {
      minutes: Math.round(remainingMinutes * factor),
      low: Math.round(remainingMinutes * low),
      high: Math.round(remainingMinutes * high),
      confidence,
      remainingStages: remaining.length,
    },
    partial: chapters.length > 0,
  };
}

/** Few samples, or very uneven ones, never read as a confident estimate. */
export function confidenceOf(ratios: number[]): Confidence {
  const n = ratios.length;
  if (n === 0) return "none";
  const base: Confidence = n < 3 ? "low" : n < 6 ? "medium" : "high";
  if (n >= 3 && quantile(ratios, 0.75) / quantile(ratios, 0.25) > 3) return base === "high" ? "medium" : "low";
  return base;
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const a = sorted[lower] ?? 0;
  const b = sorted[upper] ?? a;
  return a + (b - a) * (position - lower);
}

const round1 = (x: number) => Math.round(x * 10) / 10;
