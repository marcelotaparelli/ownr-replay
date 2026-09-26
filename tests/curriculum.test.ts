import { describe, expect, test } from "bun:test";
import type { RunResult } from "../src/domain/progress.ts";
import type { CodeFile, Exercise, Stage } from "../src/domain/stage.ts";
import { executeModules } from "../src/sandbox/execute.ts";
import { ModuleError, completeExercise, prepareExercise, prepareModules } from "../src/sandbox/modules.ts";
import { TypeChecker, locateTsc } from "../src/sandbox/typecheck.ts";
import { noveltyReport, shownSnippets, snippetProblems } from "../src/services/curriculum-check.ts";
import { goldenJourneys } from "./helpers.ts";

/**
 * The curriculum gate: anything the platform shows as correct code must be executably
 * correct. Solutions pass their tests (and the real type checker when types are taught),
 * examples are executed, toolbox and explanation snippets type-check, and each micro step
 * stays within its novelty budget. Nothing depends on manual review alone.
 */

const journeys = goldenJourneys();
const checker = new TypeChecker(await locateTsc());
/** Relevant new lines above which a micro stage must be decomposed (or justify why not). */
const NOVELTY_BUDGET = 10;

async function run(exercise: Exercise, files: CodeFile[]): Promise<RunResult | ModuleError> {
  try {
    return await executeModules(await prepareExercise(exercise, files));
  } catch (error) {
    if (error instanceof ModuleError) return error;
    throw error;
  }
}

const previousMicro = (stages: Stage[], stage: Stage): Stage | undefined => {
  const index = stages.indexOf(stage);
  const previous = stages[index - 1];
  return previous?.kind === "micro" && previous.moduleId === stage.moduleId ? previous : undefined;
};

const failures = (result: RunResult | ModuleError): unknown =>
  result instanceof ModuleError ? result.message : result.tests.filter((t) => !t.passed);

test("golden journeys load and pass cross-stage validation", () => {
  expect(journeys.length).toBeGreaterThan(0);
});

for (const journey of journeys) {
  describe(journey.id, () => {
    test("every module has stages and every stage belongs to a module", () => {
      expect(journey.modules.flatMap((m) => m.stageIds)).toEqual(journey.stages.map((s) => s.id));
    });

    for (const stage of journey.stages) {
      const exercise = stage.exercise;
      if (!exercise) continue;

      test(`${stage.id} solution passes every test`, async () => {
        expect(failures(await run(exercise, exercise.solutionFiles))).toEqual([]);
      });

      test(`${stage.id} starting point fails (the step asks for a real change)`, async () => {
        const result = await run(exercise, exercise.starterFiles);
        const failsAtRuntime = result instanceof ModuleError || result.tests.some((t) => !t.passed);
        // When types are the lesson, the type checker is part of "failing", exactly as the learner experiences it.
        const failsTypecheck =
          !failsAtRuntime && exercise.typecheck
            ? (await checker.check([...completeExercise(exercise, exercise.starterFiles), ...exercise.typecheck.files])).length > 0
            : false;
        expect(failsAtRuntime || failsTypecheck).toBe(true);
      });

      if (exercise.typecheck) {
        test(`${stage.id} solution type-checks cleanly`, async () => {
          const files = [...completeExercise(exercise, exercise.solutionFiles), ...exercise.typecheck!.files];
          expect(await checker.check(files)).toEqual([]);
        });
      }

      if (stage.kind === "checkpoint") {
        test(`${stage.id} checkpoint starts from an empty editor`, () => {
          expect(exercise.starterFiles.every((f) => f.content === "")).toBe(true);
        });
      }

      if (stage.kind === "micro") {
        const previous = previousMicro(journey.stages, stage);
        test(`${stage.id} continues from ${previous ? previous.id : "an empty editor"}`, () => {
          for (const file of exercise.starterFiles) {
            const before = previous?.exercise?.solutionFiles.find((f) => f.path === file.path)?.content ?? "";
            expect(file.content).toBe(before);
          }
        });
      }

      if (stage.examples.length > 0) {
        test(`${stage.id} examples are true (executed against the solution)`, async () => {
          const completed = completeExercise(exercise, exercise.solutionFiles);
          const main = completed[0];
          if (!main) throw new Error("no learner file");
          const names = new Bun.Transpiler({ loader: "ts" }).scan(main.content).exports.filter((n) => n !== "default");
          const body = stage.examples
            .map((ex, i) => `test(${JSON.stringify(`exemplo ${i + 1}: ${ex.expr}`)}, () => expect(${ex.expr}).toEqual(${ex.equals}));`)
            .join("\n");
          const testFile = { path: "examples.ts", content: `import { test, expect } from "replay:test";\nimport { ${names.join(", ")} } from "./${main.path}";\n${body}\n` };
          const result = await executeModules(await prepareModules(completed, testFile));
          expect(result.tests.filter((t) => !t.passed)).toEqual([]);
          expect(result.tests.length).toBe(stage.examples.length);
        });
      }
    }

    // Snippets shown as code (toolbox examples, explanation fences) must be valid programs.
    // Chapters (modules not yet decomposed) are outside this gate until they are rewritten.
    test("every code snippet shown in micro stages and checkpoints type-checks", async () => {
      expect(await snippetProblems(shownSnippets(journey.stages.filter((s) => s.kind !== "chapter")), checker)).toEqual([]);
    });

    test("micro stages stay within the novelty budget", () => {
      const report = noveltyReport(journey.stages);
      console.log("\nNovelty per micro stage (relevant new lines):\n" + report.map((r) => `  ${r.stageId.padEnd(22)} ${String(r.newLines).padStart(2)}  ${r.title}`).join("\n"));
      expect(report.filter((r) => r.newLines > NOVELTY_BUDGET && !r.exception).map((r) => `${r.stageId}: ${r.newLines}`)).toEqual([]);
    });
  });
}
