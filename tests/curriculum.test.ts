import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAllJourneys } from "../src/services/curriculum.ts";
import { prepareModules } from "../src/sandbox/modules.ts";
import { executeModules } from "../src/sandbox/execute.ts";

const journeys = loadAllJourneys(join(import.meta.dir, "../data/golden"));

test("golden journeys load and pass cross-stage validation", () => {
  expect(journeys.length).toBeGreaterThan(0);
});

// Seed of the future Stage Validator: every exercise must be solvable by its
// solution and not already solved by its starter.
for (const journey of journeys) {
  describe(journey.id, () => {
    for (const stage of journey.stages) {
      const exercise = stage.exercise;
      if (!exercise) continue;

      test(`${stage.id} solution passes every test`, async () => {
        const result = await executeModules(prepareModules(exercise.solutionFiles, exercise.testFile));
        const failed = result.tests.filter((t) => !t.passed);
        expect(failed).toEqual([]);
        expect(result.tests.length).toBeGreaterThan(0);
      });

      test(`${stage.id} starter fails at least one test`, async () => {
        const result = await executeModules(prepareModules(exercise.starterFiles, exercise.testFile));
        expect(result.tests.some((t) => !t.passed)).toBe(true);
      });

      test(`${stage.id} starter only differs from solution in exercise files`, () => {
        const solutionPaths = exercise.solutionFiles.map((f) => f.path).sort();
        expect(exercise.starterFiles.map((f) => f.path).sort()).toEqual(solutionPaths);
      });
    }
  });
}
