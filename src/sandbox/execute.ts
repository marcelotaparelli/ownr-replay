import type { RunResult } from "../domain/progress.ts";
import { createHarness, describeError, type Harness } from "./harness.ts";
import type { ModuleSet } from "./modules.ts";

declare global {
  var __replayHarness: Harness | undefined;
}

const MAX_OUTPUT = 20_000;
const MAX_DIAGNOSTIC_LINES = 80;

/** Phase names shown to the learner (server-side phases are transpilation and preparation). */
export const PHASE = {
  loading: "carregamento do módulo",
  execution: "execução dos testes",
} as const;

/**
 * Loads the bundled exercise module through a single blob: URL and runs the stage tests.
 * Runs wherever ESM + Blob URLs exist: a browser Web Worker, the Docker image,
 * or Bun itself (curriculum validation of trusted, authored code).
 * This function provides NO isolation; the caller's environment must.
 */
export async function executeModules(set: ModuleSet, perTestTimeoutMs = 1_000): Promise<RunResult> {
  const started = performance.now();
  const harness = createHarness();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (sink: string[]) => (...args: unknown[]) => {
    sink.push(args.map(format).join(" "));
  };
  const url = URL.createObjectURL(new Blob([set.code], { type: "text/javascript" }));

  globalThis.__replayHarness = harness;
  console.log = console.info = capture(stdout);
  console.warn = console.error = capture(stderr);
  try {
    try {
      await import(url);
    } catch (error) {
      // Distinguish "the learner's code threw while loading" from "the module could not load at all".
      const message = describeError(error);
      return result(started, stdout, [...stderr, loadDiagnostic(message, set.code)], [{ name: PHASE.loading, passed: false, error: message }]);
    }
    const outcomes = await harness.run(perTestTimeoutMs);
    if (outcomes.length === 0) {
      return result(started, stdout, stderr, [{ name: PHASE.execution, passed: false, error: "nenhum teste foi registrado" }]);
    }
    return result(started, stdout, stderr, outcomes);
  } finally {
    Object.assign(console, original);
    globalThis.__replayHarness = undefined;
    URL.revokeObjectURL(url);
  }
}

/** Enough of the generated JavaScript to locate a loading failure. It is the learner's own code. */
function loadDiagnostic(message: string, code: string): string {
  const lines = code.split("\n");
  const numbered = lines.slice(0, MAX_DIAGNOSTIC_LINES).map((line, i) => `${String(i + 1).padStart(3)} | ${line}`);
  const more = lines.length > MAX_DIAGNOSTIC_LINES ? [`… (+${lines.length - MAX_DIAGNOSTIC_LINES} linhas)`] : [];
  return [`Falha no ${PHASE.loading}: ${message}`, "JavaScript gerado:", ...numbered, ...more].join("\n");
}

function result(started: number, stdout: string[], stderr: string[], tests: RunResult["tests"]): RunResult {
  const err = clip(stderr.join("\n"));
  return {
    stdout: clip(stdout.join("\n")),
    ...(err ? { stderr: err } : {}),
    latencyMs: Math.round(performance.now() - started),
    tests,
  };
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const clip = (text: string): string => (text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n…" : text);
