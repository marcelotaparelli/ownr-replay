import { describe, expect, test } from "bun:test";
import { dockerArgs } from "../src/sandbox/docker-runner.ts";
import { PHASE, executeModules } from "../src/sandbox/execute.ts";
import { createHarness } from "../src/sandbox/harness.ts";
import { ModuleError, prepareExercise, prepareModules } from "../src/sandbox/modules.ts";
import { golden } from "./helpers.ts";

const tests = (body: string) => ({ path: "tests.ts", content: `import { test, expect } from "replay:test";\nimport { value } from "./a.ts";\n${body}` });

async function rejection(promise: Promise<unknown>): Promise<ModuleError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModuleError) return error;
    throw error;
  }
  throw new Error("expected a ModuleError");
}

describe("prepareModules", () => {
  test("bundles the exercise into ONE self-contained module (no imports to resolve at runtime)", async () => {
    // Regression: separate blob: modules importing each other fail in Firefox module workers.
    const set = await prepareModules([{ path: "a.ts", content: "export const value: number = 1;" }], tests(`test("v", () => expect(value).toBe(1));`));
    expect(set.code).not.toMatch(/^\s*(import|export)\b/m);
    expect(set.code).not.toContain("replay:test");
    expect((await executeModules(set)).tests).toEqual([{ name: "v", passed: true }]);
  });

  const rejected: Record<string, string> = {
    "bare package": `import fs from "node:fs"; export const value = 1;`,
    "remote url": `import x from "https://evil.example/x.js"; export const value = x;`,
    "parent directory": `import x from "../secret.ts"; export const value = x;`,
    "absolute path": `import x from "/etc/passwd"; export const value = x;`,
    "dynamic import": `export const value = 1; import("./a.ts");`,
    require: `export const value = require("fs");`,
  };
  for (const [name, content] of Object.entries(rejected)) {
    test(`rejects ${name} during module preparation`, async () => {
      const error = await rejection(prepareModules([{ path: "a.ts", content }], tests("")));
      expect(error.phase).toBe("preparation");
    });
  }

  test("syntax errors are reported as TypeScript transpilation, with the line", async () => {
    const error = await rejection(prepareModules([{ path: "a.ts", content: "export const value = 1;\nexport const = ;" }], tests("")));
    expect(error.phase).toBe("transpilation");
    expect(error.message).toContain("linha 2");
  });
});

describe("raw source reaches the runner unchanged", () => {
  const stage = golden().stages.find((s) => s.id === "ops-triage-ai.m1-01");
  const exercise = stage?.exercise;
  if (!exercise) throw new Error("micro stage 1 missing");

  test("the learner's exact Micro Stage 1 solution passes", async () => {
    const source = 'function classify(text: string): string {\n  return "INCIDENT";\n}';
    const result = await executeModules(await prepareExercise(exercise, [{ path: "classify.ts", content: source }]));
    expect(result.tests.every((t) => t.passed)).toBe(true);
  });

  test("characters that HTML would escape arrive as written and keep their meaning", async () => {
    const source = [
      "const a = 1, b = 2;",
      "const result = a < b && b > 0;",
      'const html = "<div>&</div>";',
      "const quote = 'it\\'s \"quoted\"';",
      "const path = \"C:\\\\temp\\\\x\";",
      "const tpl = `${a}&${b}<>`;",
      'function classify(text: string): string {',
      '  console.log(result, html, quote, path, tpl);',
      '  return "INCIDENT";',
      "}",
    ].join("\n");
    const set = await prepareExercise(exercise, [{ path: "classify.ts", content: source }]);
    expect(set.code).toContain("a < b && b > 0");
    expect(set.code).toContain('"<div>&</div>"');
    expect(set.code).not.toMatch(/&(lt|gt|amp|quot|#x?[0-9a-f]+);/i);
    const run = await executeModules(set);
    expect(run.tests.every((t) => t.passed)).toBe(true);
    expect(run.stdout).toBe(`true <div>&</div> it's "quoted" C:\\temp\\x 1&2<>`);
  });

  test("markdown copy artifacts (&#x20;, trailing \\) are rejected as syntax, never silently altered", async () => {
    const pasted = "function classify(text: string): string {\\\n  &#x20; return 'INCIDENT';  \\\n}";
    const error = await rejection(prepareExercise(exercise, [{ path: "classify.ts", content: pasted }]));
    expect(error.phase).toBe("transpilation");
  });
});

describe("executeModules", () => {
  test("runs tests and reports each outcome with captured stdout", async () => {
    const set = await prepareModules(
      [{ path: "a.ts", content: "export const value = 2;" }],
      tests(`test("ok", () => { console.log("hi"); expect(value).toBe(2); });\ntest("ko", () => expect(value).toBe(3));`),
    );
    const result = await executeModules(set);
    expect(result.tests.map((t) => [t.name, t.passed])).toEqual([["ok", true], ["ko", false]]);
    expect(result.tests[1]?.error).toContain("esperava 3");
    expect(result.stdout).toBe("hi");
  });

  test("a module that throws while loading is reported as module loading, with a diagnostic", async () => {
    const set = await prepareModules([{ path: "a.ts", content: `throw new Error("boom"); export const value = 1;` }], tests(`test("uses", () => expect(value).toBe(1));`));
    const result = await executeModules(set);
    expect(result.tests).toEqual([{ name: PHASE.loading, passed: false, error: "Error: boom" }]);
    expect(result.stderr).toContain("JavaScript gerado:");
  });

  test("a run that registers no tests is a failure, not 0/0", async () => {
    const result = await executeModules(await prepareModules([{ path: "a.ts", content: "export const value = 1;" }], tests("")));
    expect(result.tests).toEqual([{ name: PHASE.execution, passed: false, error: "nenhum teste foi registrado" }]);
  });
});

describe("harness", () => {
  test("a hanging async test times out instead of blocking the run", async () => {
    const h = createHarness();
    h.test("hangs", () => new Promise(() => undefined));
    h.test("after", () => h.expect(1).toBe(1));
    const outcomes = await h.run(20);
    expect(outcomes.map((o) => o.passed)).toEqual([false, true]);
    expect(outcomes[0]?.error).toContain("excedeu");
  });

  test("toEqual compares structurally and not.toBe negates", () => {
    const h = createHarness();
    h.expect({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] });
    h.expect(1).not.toBe(2);
    expect(() => h.expect({ a: 1 }).toEqual({ a: 2 })).toThrow();
  });
});

test("docker runner uses the hardened flag set", () => {
  const args = dockerArgs("rr-x");
  for (const flag of ["--network=none", "--cpus=0.5", "--memory=128m", "--pids-limit=64", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"]) {
    expect(args).toContain(flag);
  }
  expect(args).toContain("/tmp:rw,noexec,nosuid,size=16m");
});
