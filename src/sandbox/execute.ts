import type { RunResult } from "../domain/progress.ts";
import { createHarness, describeError, type Harness } from "./harness.ts";
import type { ModuleSet } from "./modules.ts";
import { HARNESS_SPECIFIER } from "./runner.ts";

declare global {
  var __replayHarness: Harness | undefined;
}

const HARNESS_MODULE =
  "export const test = (name, fn) => globalThis.__replayHarness.test(name, fn);\n" +
  "export const expect = (actual) => globalThis.__replayHarness.expect(actual);\n";

const MAX_OUTPUT = 20_000;

/**
 * Links prepared modules through blob: URLs and runs the stage tests.
 * Runs wherever ESM + Blob URLs exist: a browser Web Worker, the Docker image,
 * or Bun itself (curriculum validation of trusted, authored code).
 * This function provides NO isolation; the caller's environment must.
 */
export async function executeModules(set: ModuleSet, perTestTimeoutMs = 1_000): Promise<RunResult> {
  const started = performance.now();
  const harness = createHarness();
  const urls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (sink: string[]) => (...args: unknown[]) => {
    sink.push(args.map(format).join(" "));
  };

  globalThis.__replayHarness = harness;
  console.log = console.info = capture(stdout);
  console.warn = console.error = capture(stderr);
  try {
    const url = (code: string): string => {
      const created = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      urls.push(created);
      return created;
    };
    const resolved = new Map<string, string>([[HARNESS_SPECIFIER, url(HARNESS_MODULE)]]);
    for (const module of set.modules) {
      let code = module.code.replaceAll(`"${HARNESS_SPECIFIER}"`, JSON.stringify(resolved.get(HARNESS_SPECIFIER)));
      for (const [specifier, path] of Object.entries(module.imports)) {
        const target = resolved.get(path);
        if (target) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
      }
      resolved.set(module.path, url(code));
    }
    const entry = resolved.get(set.entry);
    if (!entry) throw new Error(`entry ${set.entry} not found`);

    try {
      await import(entry);
    } catch (error) {
      return result(started, stdout, [...stderr, describeError(error)], [
        { name: "carregar módulos", passed: false, error: describeError(error) },
      ]);
    }
    const outcomes = await harness.run(perTestTimeoutMs);
    if (outcomes.length === 0) {
      return result(started, stdout, stderr, [{ name: "testes", passed: false, error: "nenhum teste foi registrado" }]);
    }
    return result(started, stdout, stderr, outcomes);
  } finally {
    Object.assign(console, original);
    globalThis.__replayHarness = undefined;
    urls.forEach((created) => URL.revokeObjectURL(created));
  }
}

function result(
  started: number,
  stdout: string[],
  stderr: string[],
  tests: RunResult["tests"],
): RunResult {
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
