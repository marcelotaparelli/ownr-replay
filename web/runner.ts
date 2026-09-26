import type { RunResult } from "../src/domain/progress.ts";
import type { CodeFile } from "../src/domain/stage.ts";
import type { ModuleSet } from "../src/sandbox/modules.ts";
import { ApiError, api } from "./api.ts";
import { reportSyncFailure } from "./store.ts";

/** Wall-clock budget for one run in the browser; a runaway loop is killed by terminate(). */
const BROWSER_RUN_TIMEOUT_MS = 3_000;

export type RunOutcome = { result: RunResult; firstPass: boolean };

type WorkerReply = { ok: true; result: RunResult } | { ok: false; error: string };

export async function runExercise(stageId: string, files: CodeFile[]): Promise<RunOutcome> {
  let response;
  try {
    response = await api.run(stageId, files);
  } catch (error) {
    if (error instanceof ApiError && error.code === "MODULE_REJECTED") {
      return { result: failed("compilação", error.message, 0), firstPass: false };
    }
    throw error;
  }
  if (response.mode === "typecheck") {
    // Nothing ran: the types the stage teaches are wrong. Recorded as a failed attempt.
    const result: RunResult = {
      stdout: "",
      latencyMs: 0,
      tests: response.diagnostics.map((d) => ({ name: `TypeScript · ${d.file}, linha ${d.line}`, passed: false, error: `${d.code}: ${d.message}` })),
    };
    await api.attempt(stageId, result).catch(reportSyncFailure);
    return { result, firstPass: false };
  }
  const typeRow = response.typecheck === "passed" ? [{ name: "TypeScript: sem erros de tipo", passed: true }] : [];
  if (response.mode === "server") return { result: { ...response.result, tests: [...typeRow, ...response.result.tests] }, firstPass: false };

  const executed = await runInWorker(response);
  const result: RunResult = { ...executed, tests: [...typeRow, ...executed.tests] };
  const recorded = await api.attempt(stageId, result).catch((error: unknown) => {
    reportSyncFailure(error);
    return { firstPass: false };
  });
  return { result, firstPass: recorded.firstPass };
}

function runInWorker(modules: ModuleSet): Promise<RunResult> {
  const started = performance.now();
  // A fresh worker per run: no state leaks between attempts, and termination is total.
  const worker = new Worker("/run-worker.js", { type: "module" });
  return new Promise<RunResult>((resolve) => {
    const finish = (result: RunResult): void => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ...failed("execução", `tempo esgotado (${BROWSER_RUN_TIMEOUT_MS / 1000}s) — há um loop infinito?`, performance.now() - started), timedOut: true });
    }, BROWSER_RUN_TIMEOUT_MS);
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      finish(reply.ok ? reply.result : failed("execução", reply.error, performance.now() - started));
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      finish(failed("execução", event.message || "falha ao iniciar o runner", performance.now() - started));
    });
    worker.postMessage(modules);
  });
}

function failed(name: string, error: string, latencyMs: number): RunResult {
  return { stdout: "", latencyMs: Math.round(latencyMs), tests: [{ name, passed: false, error }] };
}
