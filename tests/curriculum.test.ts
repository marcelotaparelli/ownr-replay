import { describe, expect, test } from "bun:test";
import { executeModules } from "../src/sandbox/execute.ts";
import { ModuleError, prepareExercise } from "../src/sandbox/modules.ts";
import type { RunResult } from "../src/domain/progress.ts";
import type { CodeFile, Exercise } from "../src/domain/stage.ts";
import { goldenJourneys } from "./helpers.ts";

const journeys = goldenJourneys();

async function run(exercise: Exercise, files: CodeFile[]): Promise<RunResult | ModuleError> {
  try {
    return await executeModules(await prepareExercise(exercise, files));
  } catch (error) {
    if (error instanceof ModuleError) return error;
    throw error;
  }
}

test("golden journeys load and pass cross-stage validation", () => {
  expect(journeys.length).toBeGreaterThan(0);
});

// Seed of the future Stage Validator: every exercise must be solvable by its
// solution and not already solved by what the learner starts with.
for (const journey of journeys) {
  describe(journey.id, () => {
    test("every module has stages and every stage belongs to a module", () => {
      const inModules = journey.modules.flatMap((m) => m.stageIds);
      expect(inModules).toEqual(journey.stages.map((s) => s.id));
    });

    for (const stage of journey.stages) {
      const exercise = stage.exercise;
      if (!exercise) continue;

      test(`${stage.id} solution passes every test`, async () => {
        const result = await run(exercise, exercise.solutionFiles);
        if (result instanceof ModuleError) throw result;
        expect(result.tests.filter((t) => !t.passed)).toEqual([]);
      });

      test(`${stage.id} starting point fails`, async () => {
        const result = await run(exercise, exercise.starterFiles);
        const failed = result instanceof ModuleError || result.tests.some((t) => !t.passed);
        expect(failed).toBe(true);
      });

      if (stage.kind !== "chapter") {
        test(`${stage.id} starts from an empty editor`, () => {
          expect(exercise.starterFiles.every((f) => f.content === "")).toBe(true);
        });
      }
    }
  });
}
