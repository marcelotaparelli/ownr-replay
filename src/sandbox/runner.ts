import type { RunResult } from "../domain/progress.ts";
import type { ModuleSet } from "./modules.ts";

export type { RunResult };

export type RunInput = {
  /** Learner files + support files + server-owned tests, transpiled but never executed on the host. */
  modules: ModuleSet;
  timeoutMs: number;
};

/**
 * Server-side, isolated execution of learner code. This is the security
 * boundary: implementations must isolate network, filesystem, CPU and memory.
 * The production implementation is DockerSandboxRunner.
 *
 * The development BrowserRunner (web/run-worker.ts) is deliberately NOT a
 * SandboxRunner: it runs code in the learner's own browser tab, which only
 * protects the server by never executing anything on it.
 */
export interface SandboxRunner {
  run(input: RunInput): Promise<RunResult>;
}

/** Specifier stage tests use to reach the shared harness. */
export const HARNESS_SPECIFIER = "ownr:test";
