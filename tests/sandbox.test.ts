import { describe, expect, test } from "bun:test";
import { dockerArgs } from "../src/sandbox/docker-runner.ts";
import { executeModules } from "../src/sandbox/execute.ts";
import { createHarness } from "../src/sandbox/harness.ts";
import { ModuleError, prepareModules } from "../src/sandbox/modules.ts";

const tests = (body: string) => ({ path: "tests.ts", content: `import { test, expect } from "replay:test";\nimport { value } from "./a.ts";\n${body}` });

describe("prepareModules", () => {
  test("links relative imports between exercise files", () => {
    const set = prepareModules([{ path: "a.ts", content: "export const value: number = 1;" }], tests(""));
    expect(set.entry).toBe("tests.ts");
    expect(set.modules.map((m) => m.path)).toEqual(["a.ts", "tests.ts"]);
    expect(set.modules[1]?.imports).toEqual({ "./a.ts": "a.ts" });
  });

  const rejected: Record<string, string> = {
    "bare package": `import fs from "node:fs"; export const value = 1;`,
    "remote url": `import x from "https://evil.example/x.js"; export const value = x;`,
    "parent directory": `import x from "../secret.ts"; export const value = x;`,
    "dynamic import": `export const value = 1; import("./a.ts");`,
    require: `export const value = require("fs");`,
  };
  for (const [name, content] of Object.entries(rejected)) {
    test(`rejects ${name}`, () => {
      expect(() => prepareModules([{ path: "a.ts", content }], tests(""))).toThrow(ModuleError);
    });
  }

  test("reports syntax errors as ModuleError", () => {
    expect(() => prepareModules([{ path: "a.ts", content: "export const = ;" }], tests(""))).toThrow(ModuleError);
  });
});

describe("executeModules", () => {
  test("runs tests and reports each outcome with captured stdout", async () => {
    const set = prepareModules(
      [{ path: "a.ts", content: "export const value = 2;" }],
      tests(`test("ok", () => { console.log("hi"); expect(value).toBe(2); });\ntest("ko", () => expect(value).toBe(3));`),
    );
    const result = await executeModules(set);
    expect(result.tests.map((t) => [t.name, t.passed])).toEqual([["ok", true], ["ko", false]]);
    expect(result.tests[1]?.error).toContain("esperava 3");
    expect(result.stdout).toBe("hi");
  });

  test("a module that throws on load fails the run instead of crashing", async () => {
    const set = prepareModules([{ path: "a.ts", content: `throw new Error("boom"); export const value = 1;` }], tests(`test("uses", () => expect(value).toBe(1));`));
    const result = await executeModules(set);
    expect(result.tests[0]?.passed).toBe(false);
    expect(result.tests[0]?.error).toContain("boom");
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

test("a run that registers no tests is a failure, not 0/0", async () => {
  const result = await executeModules(prepareModules([{ path: "a.ts", content: "export const value = 1;" }], tests("")));
  expect(result.tests).toEqual([{ name: "testes", passed: false, error: "nenhum teste foi registrado" }]);
});
