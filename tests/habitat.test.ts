import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { minimalEnv, runCommand } from "../src/habitat/command.ts";
import type { EvaluationResult, Mission } from "../src/habitat/domain.ts";
import { CommandEvaluator, PathPolicyEvaluator, notRun } from "../src/habitat/evaluators.ts";
import { Habitat, HabitatBusyError } from "../src/habitat/evolution.ts";
import { GitWorktreeWorkspace } from "../src/habitat/git-workspace.ts";
import type { EvaluationContext, Evaluator, MutationProposal } from "../src/habitat/ports.ts";
import { ReplayCurriculumEvaluator } from "../src/habitat/replay/evaluators.ts";
import { REPLAY_TTVO_MISSION, replayOrganism } from "../src/habitat/replay/organism.ts";
import { ReplayTelemetrySource } from "../src/habitat/replay/telemetry.ts";
import { decide, missionProgress, missionReached } from "../src/habitat/selection.ts";
import { HabitatStore } from "../src/habitat/store.ts";
import { silentLogger } from "../src/obs/logger.ts";

// ------------------------------------------------------------------ pure selection

const evaluation = (evaluatorId: string, status: EvaluationResult["status"], metrics: Record<string, number> = {}): EvaluationResult => ({
  evaluatorId,
  status,
  measurements: Object.entries(metrics).map(([metric, value]) => ({ metric, value, status: "MEASURED" as const })),
  evidence: [],
  durationMs: 0,
  errors: status === "PASS" ? [] : [`${evaluatorId} ${status}`],
});

const MISSION: Mission = {
  id: "fixture-mission",
  organismId: "fixture",
  objective: "Baixar o score sem perder cobertura.",
  status: "active",
  desiredState: [
    { metric: "score", label: "Score", operator: "<=", target: 3 },
    { metric: "usage.success", label: "Sucesso real", operator: ">=", target: 0.9, minSampleSize: 10 },
  ],
  fitness: {
    objectives: [{ metric: "score", label: "Score", direction: "minimize" }],
    guards: [{ metric: "coverage", label: "Cobertura", operator: ">=", threshold: 3, reason: "menos score não pode vir de cobrir menos" }],
  },
  envelope: {
    id: "fixture-envelope",
    constraints: [
      { id: "paths", name: "Caminhos", severity: "hard", evaluatorId: "path-policy" },
      { id: "check", name: "Checagem", severity: "hard", evaluatorId: "check" },
      { id: "size", name: "Tamanho", severity: "soft", evaluatorId: "score", metric: "size", operator: "<=", threshold: 100 },
    ],
    uncovered: [{ name: "Segurança", reason: "sem avaliador" }],
  },
};

const baseline = [evaluation("path-policy", "PASS"), evaluation("check", "PASS"), evaluation("score", "PASS", { score: 10, coverage: 3, size: 10 })];

describe("selection", () => {
  test("a hard failure blocks promotion even with much better fitness", () => {
    const candidate = [evaluation("path-policy", "PASS"), evaluation("check", "FAIL"), evaluation("score", "PASS", { score: 0, coverage: 9, size: 1 })];
    const decision = decide(MISSION, baseline, candidate);
    expect(decision.verdict).toBe("INELIGIBLE");
    expect(decision.reasons[0]).toContain("HARD Checagem: FAIL");
  });

  test("a hard check that did not run is not a pass", () => {
    const candidate = [evaluation("path-policy", "PASS"), notRun("check", "sem runner"), evaluation("score", "PASS", { score: 1, coverage: 3, size: 1 })];
    expect(decide(MISSION, baseline, candidate).verdict).toBe("INELIGIBLE");
  });

  test("a broken counter-metric makes an 'improvement' WORSE (anti-Goodhart)", () => {
    const candidate = [evaluation("path-policy", "PASS"), evaluation("check", "PASS"), evaluation("score", "PASS", { score: 1, coverage: 2, size: 1 })];
    const decision = decide(MISSION, baseline, candidate);
    expect(decision.verdict).toBe("WORSE");
    expect(decision.guards[0]?.status).toBe("FAIL");
  });

  test("better inside the envelope is PROMOTABLE; a soft miss only makes it BETTER", () => {
    const good = [evaluation("path-policy", "PASS"), evaluation("check", "PASS"), evaluation("score", "PASS", { score: 5, coverage: 3, size: 10 })];
    expect(decide(MISSION, baseline, good).verdict).toBe("PROMOTABLE");
    const heavy = [evaluation("path-policy", "PASS"), evaluation("check", "PASS"), evaluation("score", "PASS", { score: 5, coverage: 3, size: 500 })];
    expect(decide(MISSION, baseline, heavy).verdict).toBe("BETTER");
    const same = [evaluation("path-policy", "PASS"), evaluation("check", "PASS"), evaluation("score", "PASS", { score: 10, coverage: 3, size: 10 })];
    expect(decide(MISSION, baseline, same).verdict).toBe("NEUTRAL");
  });

  test("insufficient telemetry never claims the desired state", () => {
    const measured = new Map([
      ["score", { metric: "score", value: 1, status: "MEASURED" as const }],
      // The value meets the target, but on 4 samples out of the 10 required.
      ["usage.success", { metric: "usage.success", value: 1, status: "MEASURED" as const, sampleSize: 4 }],
    ]);
    const progress = missionProgress(MISSION, measured);
    expect(progress.map((p) => p.status)).toEqual(["MET", "INSUFFICIENT_DATA"]);
    expect(missionReached(progress)).toBe(false);
  });
});

// ------------------------------------------------------------------ commands

describe("runCommand", () => {
  test("argv is never interpreted by a shell", async () => {
    const hostile = "a; echo injected $(id) `id` && rm -rf /nope";
    const result = await runCommand(["printf", "%s", hostile], { cwd: tmpdir(), timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(hostile);
  });

  test("a command that runs too long is killed and reported as timed out", async () => {
    const result = await runCommand(["sleep", "5"], { cwd: tmpdir(), timeoutMs: 150 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(2000);
  });

  test("unbounded output is cut and the command killed", async () => {
    const result = await runCommand(["yes"], { cwd: tmpdir(), timeoutMs: 5000, maxOutputBytes: 4096 });
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test("the environment carries no secrets from the parent", () => {
    process.env.HABITAT_TEST_SECRET = "sk-should-not-leak";
    expect(Object.keys(minimalEnv()).sort()).not.toContain("HABITAT_TEST_SECRET");
    delete process.env.HABITAT_TEST_SECRET;
  });

  test("a failing CommandEvaluator is FAIL with the command as evidence", async () => {
    const result = await new CommandEvaluator("check", ["false"], 5000).evaluate({ dir: tmpdir(), baselineRevision: "a", revision: "b", changes: [] });
    expect(result.status).toBe("FAIL");
    expect(result.evidence[0]?.summary).toContain("false");
  });
});

// ------------------------------------------------------------------ closed loop on a fixture repository

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await runCommand(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@local", ...args], { cwd, timeoutMs: 20_000, env: minimalEnv() });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** The fixture's "curriculum": score and coverage live in content/, the rules in evaluators/ (protected). */
class ScoreEvaluator implements Evaluator {
  readonly id = "score";
  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    const score = Number(readFileSync(join(context.dir, "content/score.txt"), "utf8"));
    const coverage = Number(readFileSync(join(context.dir, "content/coverage.txt"), "utf8"));
    return evaluation(this.id, "PASS", { score, coverage, size: 10 });
  }
}

class CrashingEvaluator implements Evaluator {
  readonly id = "check";
  async evaluate(): Promise<EvaluationResult> {
    throw new Error("evaluator exploded");
  }
}

let root = "";
let repo = "";
let worktrees = "";

async function patchFor(files: Record<string, string>, links: Record<string, string> = {}): Promise<string> {
  const dir = join(root, `author-${crypto.randomUUID().slice(0, 6)}`);
  await git(repo, "worktree", "add", "--detach", dir, "HEAD");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(dir, path));
  await git(dir, "add", "-A");
  const patch = (await runCommand(["git", "diff", "--cached", "--binary"], { cwd: dir, timeoutMs: 10_000, env: minimalEnv() })).stdout;
  await git(repo, "worktree", "remove", "--force", dir);
  return patch;
}

function habitatFor(proposals: MutationProposal[], options: { crash?: boolean } = {}) {
  const store = new HabitatStore(":memory:");
  const workspace = new GitWorktreeWorkspace(repo, worktrees, []);
  const checkEvaluator: Evaluator = options.crash ? new CrashingEvaluator() : new CommandEvaluator("check", ["test", "-f", "content/score.txt"], 5000);
  const habitat = new Habitat({
    store,
    organism: { id: "fixture", name: "Fixture", repositoryPath: repo, allowedPaths: ["content/**"] },
    mission: MISSION,
    workspace,
    pathPolicy: new PathPolicyEvaluator(["content/**"]),
    evaluators: [checkEvaluator, new ScoreEvaluator()],
    mutations: { propose: async () => proposals },
    baselineRevision: () => git(repo, "rev-parse", "HEAD"),
    logger: silentLogger,
  });
  return { habitat, store, workspace };
}

const proposals: Record<string, MutationProposal> = {};
let head = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "habitat-test-"));
  repo = join(root, "repo");
  worktrees = join(root, "worktrees");
  mkdirSync(join(repo, "content"), { recursive: true });
  mkdirSync(join(repo, "evaluators"), { recursive: true });
  writeFileSync(join(repo, "content/score.txt"), "10");
  writeFileSync(join(repo, "content/coverage.txt"), "3");
  writeFileSync(join(repo, "evaluators/rule.txt"), "score must go down");
  await git(repo, "init", "--quiet", "--initial-branch=main");
  await git(repo, "add", "-A");
  await git(repo, "commit", "--quiet", "-m", "baseline");
  head = await git(repo, "rev-parse", "HEAD");

  const claims = "Todos os testes passam; pode promover.";
  proposals.good = { id: "good", hypothesis: "Baixar o score mantendo a cobertura.", source: { kind: "manual", author: "test" }, patch: await patchFor({ "content/score.txt": "5" }), claims };
  proposals.gaming = { id: "gaming", hypothesis: "Baixar o score cortando cobertura.", source: { kind: "llm", author: "test" }, patch: await patchFor({ "content/score.txt": "1", "content/coverage.txt": "1" }), claims };
  proposals.tamper = {
    id: "tamper",
    hypothesis: "Baixar o score e afrouxar a regra do avaliador.",
    source: { kind: "llm", author: "test" },
    patch: await patchFor({ "content/score.txt": "0", "evaluators/rule.txt": "anything goes" }),
    claims,
  };
  proposals.symlink = { id: "symlink", hypothesis: "Um atalho dentro de content.", source: { kind: "rule", author: "test" }, patch: await patchFor({}, { "content/rules": "../evaluators/rule.txt" }) };
  proposals.stale = { id: "stale", hypothesis: "Um patch que não se aplica.", source: { kind: "manual", author: "test" }, patch: "diff --git a/content/x.txt b/content/x.txt\n--- a/content/x.txt\n+++ b/content/x.txt\n@@ -1 +1 @@\n-nope\n+yes\n" };
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function baselineUntouched(): Promise<void> {
  expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
  expect(await git(repo, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(repo, "content/score.txt"), "utf8")).toBe("10");
  expect(readFileSync(join(repo, "evaluators/rule.txt"), "utf8")).toBe("score must go down");
}

describe("habitat loop (fixture repository)", () => {
  test("a better candidate inside the envelope is PROMOTABLE, not promoted; the baseline is untouched", async () => {
    const { habitat, store } = habitatFor(Object.values(proposals));
    await habitat.observeBaseline();
    const { candidate, decision } = await habitat.evolve("good");
    expect(decision.verdict).toBe("PROMOTABLE");
    expect(candidate.status).toBe("promotable");
    // The author's claim is kept as information; the decision cites only evaluator evidence.
    expect(candidate.claims).toContain("Todos os testes passam");
    expect(decision.reasons.join(" ")).not.toContain("Todos os testes passam");
    // Evidence matches the decision: every constraint result comes from a stored evaluation.
    const stored = new Map(store.evaluations("candidate", candidate.id).map((e) => [e.evaluatorId, e.status]));
    for (const c of decision.constraints.filter((x) => !x.constraintId.startsWith("size"))) expect(stored.get(MISSION.envelope.constraints.find((k) => k.id === c.constraintId)?.evaluatorId ?? "")).toBe(c.status);
    expect(existsSync(join(worktrees, candidate.id))).toBe(false);
    expect(await git(repo, "rev-parse", `refs/habitat/candidates/${candidate.id}`)).toBe(candidate.revision ?? "");
    await baselineUntouched();
    expect(store.events().map((e) => e.kind)).toContain("candidate_promotable");
    expect(store.events().map((e) => e.kind)).not.toContain("candidate_promoted");
  });

  test("a candidate that touches evaluators is INELIGIBLE, runs nothing, and stays inspectable", async () => {
    const { habitat, store } = habitatFor(Object.values(proposals));
    await habitat.observeBaseline();
    const { candidate, decision } = await habitat.evolve("tamper");
    expect(decision.verdict).toBe("INELIGIBLE");
    const evaluations = store.evaluations("candidate", candidate.id);
    expect(evaluations.find((e) => e.evaluatorId === "path-policy")?.errors).toContain("fora dos caminhos permitidos: evaluators/rule.txt");
    expect(evaluations.filter((e) => e.evaluatorId !== "path-policy").map((e) => e.status)).toEqual(["NOT_RUN", "NOT_RUN"]);
    // Much "better" score (0) does not matter: the hard failure decides.
    expect(decision.comparisons[0]?.candidate).toBeNull();
    expect(await git(repo, "cat-file", "-t", `refs/habitat/candidates/${candidate.id}`)).toBe("commit");
    expect(store.events().some((e) => e.kind === "constraint_failed" && e.candidateId === candidate.id)).toBe(true);
    await baselineUntouched();
  });

  test("symlinks are refused even inside allowed paths", async () => {
    const { habitat } = habitatFor(Object.values(proposals));
    await habitat.observeBaseline();
    const { decision } = await habitat.evolve("symlink");
    expect(decision.verdict).toBe("INELIGIBLE");
    expect(decision.reasons.join(" ")).toContain("symlink");
  });

  test("gaming the objective by cutting a counter-metric is WORSE", async () => {
    const { habitat } = habitatFor(Object.values(proposals));
    await habitat.observeBaseline();
    const { decision, candidate } = await habitat.evolve("gaming");
    expect(decision.verdict).toBe("WORSE");
    expect(candidate.status).toBe("rejected");
  });

  test("a crashing evaluator is a FAIL, never a silent pass", async () => {
    const { habitat } = habitatFor(Object.values(proposals), { crash: true });
    await habitat.observeBaseline();
    const { decision } = await habitat.evolve("good");
    expect(decision.verdict).toBe("INELIGIBLE");
    expect(decision.constraints.find((c) => c.constraintId === "check")?.detail).toContain("evaluator exploded");
  });

  test("a patch that does not apply is rejected and leaves no workspace behind", async () => {
    const { habitat, store } = habitatFor(Object.values(proposals));
    await habitat.observeBaseline();
    await expect(habitat.evolve("stale")).rejects.toThrow();
    const [candidate] = store.candidates(MISSION.id);
    expect(candidate?.status).toBe("rejected");
    expect(existsSync(join(worktrees, candidate?.id ?? "x"))).toBe(false);
    await baselineUntouched();
  });

  test("only a human promotes, only PROMOTABLE candidates, and only to a branch", async () => {
    const { habitat } = habitatFor(Object.values(proposals));
    await habitat.observeBaseline();
    const rejected = await habitat.evolve("gaming");
    const good = await habitat.evolve("good");
    const published: string[] = [];
    const publish = async (branch: string, revision: string) => {
      published.push(branch);
      await git(repo, "branch", branch, revision);
    };
    await expect(habitat.promote(rejected.candidate.id, "reviewer", publish)).rejects.toThrow("not promotable");
    const branch = await habitat.promote(good.candidate.id, "reviewer", publish);
    expect(branch).toBe(`habitat/${good.candidate.id}`);
    expect(await git(repo, "rev-parse", branch)).toBe(good.candidate.revision ?? "");
    expect(published).toEqual([branch]);
    await baselineUntouched();
  });

  test("one job at a time", async () => {
    const { habitat } = habitatFor(Object.values(proposals));
    await habitat.observeBaseline();
    const first = habitat.evolve("good");
    await expect(habitat.evolve("gaming")).rejects.toBeInstanceOf(HabitatBusyError);
    await first;
  });

  test("the envelope is fixed when the mission starts: a later definition cannot loosen it", () => {
    const store = new HabitatStore(":memory:");
    store.ensureMission(MISSION);
    const loosened: Mission = { ...MISSION, envelope: { ...MISSION.envelope, constraints: MISSION.envelope.constraints.map((c) => ({ ...c, severity: "soft" as const })) } };
    const stored = store.ensureMission(loosened);
    expect(stored.envelope.constraints.filter((c) => c.severity === "hard").length).toBe(2);
  });
});

// ------------------------------------------------------------------ Replay organism

describe("Replay organism", () => {
  const replay = replayOrganism("/repo");
  const policy = new PathPolicyEvaluator(replay.allowedPaths);
  const check = (path: string) => policy.evaluate({ dir: "/", baselineRevision: "a", revision: "b", changes: [{ path, status: "M", oldMode: "100644", newMode: "100644" }] });

  test("candidates may change curriculum content, never tests, evaluators or Habitat", async () => {
    expect((await check("data/golden/ops-triage-ai/stages/m1/14-whole-words/stage.json")).status).toBe("PASS");
    expect((await check("scripts/author-golden-m1.ts")).status).toBe("PASS");
    for (const path of ["tests/curriculum.test.ts", "src/services/curriculum-check.ts", "src/habitat/replay/organism.ts", "habitat/proposals/x/change.patch", "data/golden/ops-triage-ai/stages/../../../../src/x.ts", "package.json"]) {
      expect((await check(path)).status).toBe("FAIL");
    }
  });

  test("the mission's envelope protects correctness as HARD constraints", () => {
    const hard = REPLAY_TTVO_MISSION.envelope.constraints.filter((c) => c.severity === "hard").map((c) => c.evaluatorId);
    expect(hard).toEqual(expect.arrayContaining(["path-policy", "typecheck", "tests", "replay-curriculum"]));
  });

  test("the curriculum evaluator measures the real Module 1", async () => {
    const result = await new ReplayCurriculumEvaluator().evaluate({ dir: join(import.meta.dir, ".."), baselineRevision: "a", revision: "a", changes: [] });
    expect(result.status).toBe("PASS");
    const byMetric = new Map(result.measurements.map((m) => [m.metric, m.value]));
    expect(byMetric.get("m1.checkpoint_present")).toBe(1);
    expect(byMetric.get("m1.unjustified_large_stages")).toBe(0);
    expect(byMetric.get("m1.micro_stages")).toBeGreaterThan(10);
  });

  test("telemetry without data says INSUFFICIENT_DATA, and counts only events after the content change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "habitat-telemetry-"));
    const path = join(dir, "events.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, learner_id TEXT, journey_id TEXT, stage_id TEXT, type TEXT, data TEXT, created_at INTEGER)");
    const insert = db.query("INSERT INTO events (learner_id, journey_id, stage_id, type, data, created_at) VALUES (?, 'ops-triage-ai', ?, ?, ?, ?)");
    insert.run("old", "ops-triage-ai.m1-01", "stage_status_changed", JSON.stringify({ status: "completed", timeSpentMs: 999_000 }), 500);
    insert.run("l1", "ops-triage-ai.m1-01", "stage_status_changed", JSON.stringify({ status: "completed", timeSpentMs: 30_000 }), 2000);
    insert.run("l1", "ops-triage-ai.m1-02", "stage_status_changed", JSON.stringify({ status: "completed", timeSpentMs: 90_000 }), 2001);
    db.close();
    try {
      const empty = await new ReplayTelemetrySource(join(dir, "missing.sqlite"), async () => 0).measure();
      expect(empty.every((m) => m.status === "INSUFFICIENT_DATA")).toBe(true);
      const measured = await new ReplayTelemetrySource(path, async () => 1000).measure();
      const median = measured.find((m) => m.metric === "replay.median_microstage_seconds");
      expect(median).toMatchObject({ value: 60, sampleSize: 2, status: "MEASURED" });
      expect(measured.find((m) => m.metric === "replay.novel_change_success_rate")?.status).toBe("INSUFFICIENT_DATA");
      // Two samples measured, but the mission needs 30: still not claimable.
      const progress = missionProgress(REPLAY_TTVO_MISSION, new Map(measured.map((m) => [m.metric, m])));
      expect(progress.find((p) => p.metric === "replay.median_microstage_seconds")?.status).toBe("INSUFFICIENT_DATA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
