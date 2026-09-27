import { describe, expect, test } from "bun:test";
import { confidenceOf, planJourney, type StageProgressView } from "../src/domain/pace.ts";
import type { StageStatus } from "../src/domain/progress.ts";
import { golden } from "./helpers.ts";

type S = { id: string; kind: "micro" | "checkpoint" | "chapter"; moduleId: string; estimatedMinutes: number };
const micro = (i: number, minutes = 1): S => ({ id: `m1-${String(i).padStart(2, "0")}`, kind: "micro", moduleId: "m1", estimatedMinutes: minutes });
const STAGES: S[] = [...Array.from({ length: 10 }, (_, i) => micro(i + 1)), { id: "m1-99", kind: "checkpoint", moduleId: "m1", estimatedMinutes: 5 }];
const WITH_CHAPTERS: S[] = [...STAGES, { id: "02", kind: "chapter", moduleId: "m2", estimatedMinutes: 6 }, { id: "03", kind: "chapter", moduleId: "m3", estimatedMinutes: 8 }];

const minutes = (m: number) => m * 60_000;
function progress(entries: Record<string, [StageStatus, number?]>): (id: string) => StageProgressView {
  return (id) => {
    const [status, spent] = entries[id] ?? ["not_started", 0];
    return { status, timeSpentMs: spent ?? 0 };
  };
}

describe("journey plan", () => {
  test("progress is weighted by effort: a checkpoint weighs more than a micro stage and is counted separately", () => {
    const microsOnly = planJourney(STAGES, progress({ "m1-01": ["completed", minutes(1)], "m1-02": ["completed", minutes(1)] }));
    const checkpointOnly = planJourney(STAGES, progress({ "m1-99": ["completed", minutes(5)] }));
    expect(microsOnly?.percent).toBe(13); // 2 of 15 effort-minutes
    expect(checkpointOnly?.percent).toBe(33); // 5 of 15
    expect(checkpointOnly?.checkpoints).toEqual({ done: 1, total: 1 });
    expect(checkpointOnly?.micro).toEqual({ done: 0, total: 10 });
  });

  test("skipped_known counts as progress but never as pace; a plain skip is neither", () => {
    const plan = planJourney(STAGES, progress({ "m1-01": ["skipped_known", minutes(0.1)], "m1-02": ["skipped", minutes(3)], "m1-03": ["completed", minutes(2)] }));
    expect(plan?.micro.done).toBe(2);
    expect(plan?.pace).toMatchObject({ samples: 1, skippedKnown: 1, medianMinutes: 2 });
    expect(plan?.eta.remainingStages).toBe(9);
  });

  test("skimmed completions count as progress but not as pace; idle time is capped", () => {
    const plan = planJourney(STAGES, progress({ "m1-01": ["completed", 5_000], "m1-02": ["completed", 9_000], "m1-03": ["completed", minutes(600)] }));
    expect(plan?.micro.done).toBe(3);
    expect(plan?.pace).toMatchObject({ samples: 1, tooFast: 2, medianMinutes: 45 });
  });

  test("with no samples the ETA is the authored estimate, with no confidence claimed", () => {
    const plan = planJourney(STAGES, progress({}));
    expect(plan?.eta).toMatchObject({ minutes: 15, confidence: "none", remainingStages: 11 });
    expect(plan?.pace.factor).toBe(1);
  });

  test("the ETA learns the learner's pace, but only slowly while samples are few", () => {
    const slow = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [micro(i + 1).id, ["completed", minutes(4)] as [StageStatus, number]]));
    const one = planJourney(STAGES, progress(slow(1)));
    const six = planJourney(STAGES, progress(slow(6)));
    // Every sample says "4× the estimate": one sample moves the factor a little, six move it a lot.
    expect(one?.pace.factor).toBeGreaterThan(1);
    expect(one?.pace.factor).toBeLessThan(2);
    expect(six?.pace.factor).toBe(2.5);
    // 4 micro minutes + 5 checkpoint minutes left, at 4^(6/9) ≈ 2.52× (the prior still holds 3 of 9 votes).
    expect(six?.eta.minutes).toBe(23);
    expect(one?.pace.factor).toBe(1.4);
    expect(one?.eta.confidence).toBe("low");
    expect(six?.eta.confidence).toBe("high");
    // Identical samples still leave a band: a handful of stages cannot pin the future down.
    expect(six?.eta.low).toBeLessThan(six?.eta.minutes ?? 0);
    expect((six?.eta.high ?? 0) / (six?.eta.low ?? 1)).toBeGreaterThan(1.9);
    expect(six?.eta.high).toBeGreaterThan(six?.eta.minutes ?? 0);
  });

  test("confidence: few samples are low, uneven samples are downgraded", () => {
    expect([confidenceOf([]), confidenceOf([1]), confidenceOf([1, 1, 1]), confidenceOf([1, 1, 1, 1, 1, 1])]).toEqual(["none", "low", "medium", "high"]);
    expect(confidenceOf([0.2, 0.2, 1, 3, 3, 3])).toBe("medium");
    expect(confidenceOf([0.2, 1, 5])).toBe("low");
  });

  test("chapters are counted but never estimated: the plan says it is partial", () => {
    const plan = planJourney(WITH_CHAPTERS, progress({ "02": ["completed", minutes(30)] }));
    expect(plan?.partial).toBe(true);
    expect(plan?.unmapped).toEqual({ done: 1, total: 2, modules: 2 });
    expect(plan?.percent).toBe(0);
    expect(plan?.eta.minutes).toBe(15);
    expect(planJourney(STAGES, progress({}))?.partial).toBe(false);
    expect(planJourney(WITH_CHAPTERS.filter((s) => s.kind === "chapter"), progress({}))).toBeNull();
  });

  test("on the real journey: Module 1 is the mapped route, modules 2–8 stay outside the ETA", () => {
    const plan = planJourney(golden().stages, progress({}));
    expect(plan?.micro.total).toBeGreaterThan(10);
    expect(plan?.checkpoints.total).toBe(1);
    expect(plan?.unmapped.modules).toBe(7);
    expect(plan?.partial).toBe(true);
  });
});
