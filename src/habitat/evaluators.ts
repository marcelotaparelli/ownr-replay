import type { EvaluationResult, Measurement } from "./domain.ts";
import { minimalEnv, runCommand, tail } from "./command.ts";
import type { EvaluationContext, Evaluator } from "./ports.ts";

const SYMLINK_MODE = "120000";

/**
 * Candidates may only change the organism's allowed paths. This runs before anything
 * executes: a candidate that touches tests, evaluators, the envelope or Habitat itself
 * never gets to run code.
 */
export class PathPolicyEvaluator implements Evaluator {
  readonly id = "path-policy";

  constructor(private readonly allowed: string[]) {}

  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    const started = performance.now();
    const outside = context.changes.filter((c) => !this.allowed.some((pattern) => matches(pattern, c.path)));
    const symlinks = context.changes.filter((c) => c.newMode === SYMLINK_MODE);
    const errors = [
      ...outside.map((c) => `fora dos caminhos permitidos: ${c.path}`),
      ...symlinks.map((c) => `symlink não permitido: ${c.path}`),
    ];
    return {
      evaluatorId: this.id,
      status: context.changes.length > 0 && errors.length === 0 ? "PASS" : "FAIL",
      measurements: [{ metric: "candidate.changed_files", value: context.changes.length, status: "MEASURED" }],
      evidence: [{ kind: "files", summary: `${context.changes.length} arquivo(s) alterado(s)`, detail: context.changes.map((c) => `${c.status} ${c.path}`).join("\n") }],
      durationMs: Math.round(performance.now() - started),
      errors: context.changes.length === 0 ? ["o candidate não altera nada"] : errors,
    };
  }
}

/** Glob subset: "dir/**" (anything below) or an exact path. */
function matches(pattern: string, path: string): boolean {
  if (path.split("/").some((part) => part === ".." || part === "")) return false;
  return pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

/** Runs a command in the candidate's workspace and judges it only by its exit code. */
export class CommandEvaluator implements Evaluator {
  constructor(
    readonly id: string,
    private readonly argv: string[],
    private readonly timeoutMs: number,
    private readonly parse: (output: string) => Measurement[] = () => [],
  ) {}

  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    const result = await runCommand(this.argv, { cwd: context.dir, timeoutMs: this.timeoutMs, env: minimalEnv() });
    const output = `${result.stdout}\n${result.stderr}`;
    const errors = result.timedOut ? [`excedeu ${this.timeoutMs} ms`] : result.truncated ? ["saída excedeu o limite"] : result.exitCode === 0 ? [] : [`código de saída ${result.exitCode}`];
    return {
      evaluatorId: this.id,
      status: result.exitCode === 0 ? "PASS" : "FAIL",
      measurements: [{ metric: `${this.id}.duration_ms`, value: result.durationMs, status: "MEASURED", unit: "ms" }, ...this.parse(output)],
      evidence: [{ kind: "command", summary: `${this.argv.join(" ")} → exit ${result.exitCode ?? "—"} em ${result.durationMs} ms`, detail: tail(output, 40) }],
      durationMs: result.durationMs,
      errors,
    };
  }
}

/** "169 pass / 0 fail" from bun test output. */
export function bunTestCounts(output: string): Measurement[] {
  const pass = /^\s*(\d+) pass$/m.exec(output)?.[1];
  const fail = /^\s*(\d+) fail$/m.exec(output)?.[1];
  const out: Measurement[] = [];
  if (pass !== undefined) out.push({ metric: "tests.pass", value: Number(pass), status: "MEASURED" });
  if (fail !== undefined) out.push({ metric: "tests.fail", value: Number(fail), status: "MEASURED" });
  return out;
}

/** An evaluator that did not run must say so — it never counts as passing. */
export function notRun(evaluatorId: string, reason: string): EvaluationResult {
  return { evaluatorId, status: "NOT_RUN", measurements: [], evidence: [{ kind: "note", summary: reason }], durationMs: 0, errors: [reason] };
}
