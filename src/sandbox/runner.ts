import type { CodeFile } from "../domain/stage.ts";
import type { RunResult } from "../domain/progress.ts";

export type { RunResult };

export type RunInput = {
  /** Learner files, already restricted to the exercise's file names. */
  files: CodeFile[];
  /** Server-owned tests; never supplied by the client. */
  testFile: CodeFile;
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
export const HARNESS_SPECIFIER = "replay:test";
