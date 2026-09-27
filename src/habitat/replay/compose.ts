import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Logger } from "../../obs/logger.ts";
import { minimalEnv, runCommand } from "../command.ts";
import { Habitat } from "../evolution.ts";
import { GitWorktreeWorkspace } from "../git-workspace.ts";
import { DirectoryMutationProvider } from "../manual-mutations.ts";
import { HabitatStore } from "../store.ts";
import { REPLAY_TTVO_MISSION, replayEvaluators, replayOrganism } from "./organism.ts";
import { ReplayTelemetrySource } from "./telemetry.ts";

const Env = z.object({
  HABITAT_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  HABITAT_DB: z.string().min(1).default("habitat.sqlite"),
  /** Outside the repository, so the organism's own `bun test` never discovers candidate checkouts. */
  HABITAT_WORKTREES: z.string().min(1).default(join(homedir(), ".cache/ownr-habitat/worktrees")),
  HABITAT_PROPOSALS: z.string().min(1).default("habitat/proposals"),
  /** The Replay's learning events, opened read-only. */
  DB_PATH: z.string().min(1).default("repo-replay.sqlite"),
});
export type HabitatConfig = z.infer<typeof Env>;

export function loadHabitatConfig(env: Record<string, string | undefined> = process.env): HabitatConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error("Invalid Habitat configuration: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  return parsed.data;
}

const M1_CONTENT = "data/golden/ops-triage-ai/stages/m1";

/** Wires the Replay organism into a Habitat. `repository` is the organism's git checkout (never evaluated in place). */
export function createReplayHabitat(repository: string, config: HabitatConfig, logger: Logger) {
  const root = resolve(repository);
  const git = async (args: string[]): Promise<string> => {
    const result = await runCommand(["git", ...args], { cwd: root, timeoutMs: 30_000, env: minimalEnv() });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} falhou: ${result.stderr.trim().slice(0, 300)}`);
    return result.stdout.trim();
  };
  const baselineRevision = () => git(["rev-parse", "HEAD"]);
  const store = new HabitatStore(resolve(root, config.HABITAT_DB));
  const workspace = new GitWorktreeWorkspace(root, config.HABITAT_WORKTREES);
  const { pathPolicy, evaluators } = replayEvaluators();
  // Telemetry only counts usage of the Module 1 content that is deployed now.
  const since = async () => Number(await git(["log", "-1", "--format=%ct", await baselineRevision(), "--", M1_CONTENT])) * 1000;
  const habitat = new Habitat({
    store,
    organism: replayOrganism(root),
    mission: REPLAY_TTVO_MISSION,
    workspace,
    pathPolicy,
    evaluators,
    mutations: new DirectoryMutationProvider(resolve(root, config.HABITAT_PROPOSALS)),
    telemetry: new ReplayTelemetrySource(resolve(root, config.DB_PATH), since),
    baselineRevision,
    logger,
  });
  /** Promotion publishes a local branch for a human to review and merge. Never pushes, never deploys. */
  const publish = async (branch: string, revision: string): Promise<void> => {
    await git(["branch", branch, revision]);
  };
  return { habitat, store, workspace, organism: replayOrganism(root), publish };
}
