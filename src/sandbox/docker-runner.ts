import type { RunResult } from "../domain/progress.ts";
import { RunResult as RunResultSchema } from "../domain/progress.ts";
import { readBounded } from "./process.ts";
import type { RunInput, SandboxRunner } from "./runner.ts";

export const SANDBOX_IMAGE = "repo-replay-sandbox-ts:latest";
/** Container start-up is not charged against the learner's time budget. */
const STARTUP_ALLOWANCE_MS = 2_000;
/** The container can print forever until killed; never buffer more than this. */
const MAX_OUTPUT_BYTES = 256 * 1024;
const OOM_EXIT_CODE = 137;

export function dockerArgs(name: string, image = SANDBOX_IMAGE): string[] {
  return [
    "run", "--rm", "-i",
    "--name", name,
    "--network=none",
    "--cpus=0.5",
    "--memory=128m",
    "--memory-swap=128m",
    "--pids-limit=64",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user", "65534:65534",
    image,
  ];
}

/**
 * Ephemeral hardened container per run (default seccomp profile).
 * Modules arrive transpiled from the host (no execution there) and run only inside
 * the container. A warm SandboxPool can replace this behind the same interface.
 * NOT VERIFIED in this environment: Docker is unavailable here.
 */
export class DockerSandboxRunner implements SandboxRunner {
  constructor(private readonly image = SANDBOX_IMAGE) {}

  async run(input: RunInput): Promise<RunResult> {
    const started = performance.now();
    const name = `rr-${crypto.randomUUID()}`;
    const proc = Bun.spawn(["docker", ...dockerArgs(name, this.image)], {
      stdin: new Blob([JSON.stringify(input.modules)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" });
      proc.kill();
    }, input.timeoutMs + STARTUP_ALLOWANCE_MS);

    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(proc.stdout, MAX_OUTPUT_BYTES, () => proc.kill()),
      readBounded(proc.stderr, MAX_OUTPUT_BYTES, () => proc.kill()),
      proc.exited,
    ]);
    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - started);

    if (timedOut) return failure("tempo esgotado — loop infinito?", latencyMs, true);
    if (exitCode === OOM_EXIT_CODE) return failure("memória esgotada (limite 128 MB)", latencyMs);
    const parsed = RunResultSchema.safeParse(safeJson(stdout.trim().split("\n").at(-1) ?? ""));
    if (!parsed.success) return failure(stderr.slice(0, 2_000) || `sandbox saiu com código ${exitCode}`, latencyMs);
    return { ...parsed.data, latencyMs };
  }
}

function failure(error: string, latencyMs: number, timedOut = false): RunResult {
  return { stdout: "", stderr: error, latencyMs, ...(timedOut ? { timedOut } : {}), tests: [{ name: "execução", passed: false, error }] };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
