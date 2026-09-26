import { describe, expect, test } from "bun:test";
import { completeExercise } from "../src/sandbox/modules.ts";
import { TypeChecker, TypecheckBusyError, locateTsc, parseDiagnostics } from "../src/sandbox/typecheck.ts";
import type { CodeFile, Exercise } from "../src/domain/stage.ts";
import { golden, testApp } from "./helpers.ts";

const checker = new TypeChecker(await locateTsc());
const journey = golden();

function typedExercise(id: string): { exercise: Exercise; checks: CodeFile[] } {
  const exercise = journey.stages.find((s) => s.id === id)?.exercise;
  if (!exercise?.typecheck) throw new Error(`${id} has no typecheck`);
  return { exercise, checks: exercise.typecheck.files };
}

const TYPED_STAGE = "ops-triage-ai.m1-15";

describe("the enum stage: types are verified for real", () => {
  const { exercise, checks } = typedExercise(TYPED_STAGE);
  const solution = exercise.solutionFiles[0]?.content ?? "";
  const run = (content: string) => checker.check([...completeExercise(exercise, [{ path: "classify.ts", content }]), ...checks]);

  test("the solution passes the checker", async () => {
    expect(await run(solution)).toEqual([]);
  });

  test('const category: Category = "BILLIGN" is a real TypeScript error, on the learner\'s line', async () => {
    const lines = solution.split("\n").length;
    const diagnostics = await run(`${solution}\n\nconst category: Category = "BILLIGN";`);
    expect(diagnostics).toEqual([
      { file: "classify.ts", line: lines + 2, code: "TS2322", message: `Type '"BILLIGN"' is not assignable to type 'Category'.` },
    ]);
  });

  test("a Category that accepts any string fails the type-level check", async () => {
    const loose = solution.replace(/enum Category \{[\s\S]*?\n\}/, 'type Category = string;\nconst Category = { INCIDENT: "INCIDENT", BUG: "BUG", ACCESS: "ACCESS", OTHER: "OTHER" };');
    expect(loose).not.toBe(solution);
    const diagnostics = await run(loose);
    expect(diagnostics.map((d) => [d.file, d.code])).toContainEqual(["check.ts", "TS2578"]);
  });
});

test("every stage that verifies types ships a solution that type-checks cleanly", async () => {
  for (const stage of journey.stages) {
    const exercise = stage.exercise;
    if (!exercise?.typecheck) continue;
    const diagnostics = await checker.check([...completeExercise(exercise, exercise.solutionFiles), ...exercise.typecheck.files]);
    expect({ stage: stage.id, diagnostics }).toEqual({ stage: stage.id, diagnostics: [] });
  }
});

test("learner code cannot pull files from outside the stage into the checker", async () => {
  const diagnostics = await checker.check([
    { path: "evil.ts", content: `/// <reference path="/etc/hostname" />\ntype P = typeof import("/etc/passwd");\nexport const x: P = 1;` },
  ]);
  const text = JSON.stringify(diagnostics);
  expect(text).toContain("Cannot find module '/etc/passwd'");
  expect(text).not.toContain("root:");
});

test("concurrency is bounded", async () => {
  await expect(new TypeChecker("/nonexistent", 0).check([])).rejects.toBeInstanceOf(TypecheckBusyError);
});

test("parses tsc diagnostics and ignores anything else", () => {
  const output = "a.ts(3,7): error TS2322: Type 'x' is not assignable.\nsomething else\n../etc/x.ts(1,1): error TS1: no";
  expect(parseDiagnostics(output)).toEqual([{ file: "a.ts", line: 3, code: "TS2322", message: "Type 'x' is not assignable." }]);
});

describe("API", () => {
  const stageId = TYPED_STAGE;
  const solution = () => typedExercise(TYPED_STAGE).exercise.solutionFiles[0]?.content ?? "";

  test("a type error is reported before anything runs", async () => {
    const { call } = testApp({ typeChecker: checker });
    const files = [{ path: "classify.ts", content: `${solution()}\nconst c: Category = "BILLIGN";` }];
    const body = await (await call("POST", `/api/stages/${stageId}/run`, { files })).json();
    expect(body.mode).toBe("typecheck");
    expect(body.diagnostics[0].code).toBe("TS2322");
    expect(body.code).toBeUndefined();
  });

  test("correct types go on to run, marked as checked", async () => {
    const { call } = testApp({ typeChecker: checker });
    const body = await (await call("POST", `/api/stages/${stageId}/run`, { files: [{ path: "classify.ts", content: solution() }] })).json();
    expect(body.mode).toBe("browser");
    expect(body.typecheck).toBe("passed");
  });

  test("stages without typecheck never need the checker", async () => {
    const { call } = testApp({ typeChecker: null });
    const files = [{ path: "classify.ts", content: 'function classify(text) { return "INCIDENT"; }' }];
    expect((await call("POST", "/api/stages/ops-triage-ai.m1-01/run", { files })).status).toBe(200);
  });

  test("a typed stage without a checker fails loudly instead of skipping the check", async () => {
    const { call } = testApp({ typeChecker: null });
    const response = await call("POST", `/api/stages/${stageId}/run`, { files: [{ path: "classify.ts", content: solution() }] });
    expect(response.status).toBe(503);
  });
});
