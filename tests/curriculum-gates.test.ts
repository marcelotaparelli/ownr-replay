import { expect, test } from "bun:test";
import { addedLines, noveltyLines } from "../src/domain/line-diff.ts";
import { TypeChecker, locateTsc } from "../src/sandbox/typecheck.ts";
import { snippetProblems } from "../src/services/curriculum-check.ts";
import { validateJourney } from "../src/services/curriculum.ts";
import { golden } from "./helpers.ts";

const checker = new TypeChecker(await locateTsc());

test("regression: invalid code shown to the learner is rejected (&& return)", async () => {
  const problems = await snippetProblems(
    [{ where: "m1 toolbox", code: 'function classify(text: string): string {\n  text.includes("down") && return "INCIDENT";\n  return "OTHER";\n}' }],
    checker,
  );
  expect(problems.length).toBeGreaterThan(0);
  expect(problems[0]).toContain("m1 toolbox");
});

test("regression: a top-level return in a toolbox example is rejected", async () => {
  expect((await snippetProblems([{ where: "if", code: 'if (idade >= 18) return "adulto";\nreturn "menor";' }], checker)).length).toBeGreaterThan(0);
});

test("valid snippets pass", async () => {
  expect(await snippetProblems([{ where: "ok", code: 'function kind(age: number): string {\n  if (age >= 18) {\n    return "adulto";\n  }\n  return "menor";\n}' }], checker)).toEqual([]);
});

test("shown code must be the validated solution, and never contain HTML entities", () => {
  const journey = golden();
  const stage = journey.stages.find((s) => s.id === "ops-triage-ai.m1-02");
  if (!stage?.exercise) throw new Error("missing stage");
  const tampered = {
    ...stage,
    referenceCode: [{ path: "classify.ts", content: 'function classify(text: string): string {\n&#x20; return "INCIDENT";\n}' }],
  };
  const problems = validateJourney({ ...journey, stages: journey.stages.map((s) => (s.id === stage.id ? tampered : s)) });
  expect(problems).toContain("ops-triage-ai.m1-02: shown code classify.ts differs from the validated solution");
  expect(problems).toContain("ops-triage-ai.m1-02: content contains an HTML entity");
});

test("green = real delta: only the added lines, not moved or reformatted ones", () => {
  const before = 'function classify(text: string): string {\n  return "INCIDENT";\n}';
  const after = 'function classify(text: string): string {\n  if (text.includes("down")) {\n    return "INCIDENT";\n  }\n  return "OTHER";\n}';
  expect(addedLines(before, after)).toEqual([2, 4, 5]);
  expect(noveltyLines(before, after)).toEqual([2, 5]);
  // Re-indented and reordered lines are not new.
  expect(addedLines("const a = 1;\nconst b = 2;", "const b   = 2;\n    const a = 1;")).toEqual([]);
  // A first step is all new.
  expect(addedLines("", "const a = 1;")).toEqual([1]);
});
