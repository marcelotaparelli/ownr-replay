import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { graphProblems } from "../domain/architecture-diff.ts";
import type { Journey } from "../domain/journey.ts";
import {
  Checkpoint,
  CodeFile,
  Concept,
  ExplanationBlock,
  OriginalCodeReference,
  Stage,
  StageSummary,
  ToolReference,
} from "../domain/stage.ts";
import { ArchitectureGraph } from "../domain/architecture.ts";

/**
 * Loads hand-authored journeys from disk. Layout per journey:
 *   journey.json
 *   original/<repo path>          files copied from the real repo at `repo.sha`
 *   stages/<NN-slug>/stage.json   pedagogy
 *   stages/<NN-slug>/reference/   code shown as "código pronto"
 *   stages/<NN-slug>/starter/     exercise starting point
 *   stages/<NN-slug>/solution/    optional; defaults to reference/
 *   stages/<NN-slug>/tests.ts     tests run against the learner's files
 * The future Stage Generator will produce the same `Journey` shape.
 */

const JourneySource = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  description: z.string().min(1),
  repo: z.strictObject({
    owner: z.string().min(1),
    name: z.string().min(1),
    url: z.string().url(),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  stages: z.array(z.string().regex(/^\d{2}-[a-z0-9-]+$/)).min(1),
  concepts: z.array(Concept).min(1),
});

const StageSource = z.strictObject({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  goal: z.string().min(1),
  problem: z.string().min(1),
  estimatedMinutes: z.number().int().positive(),
  introduces: z.array(z.string()),
  prerequisites: z.array(z.string()),
  architecture: ArchitectureGraph,
  referenceCode: z.array(z.string()).min(1),
  explanation: z.array(ExplanationBlock),
  originalCodeRefs: z.array(OriginalCodeReference.omit({ snippet: true, url: true })),
  exercise: z
    .strictObject({
      instructions: z.string().min(1),
      starterFiles: z.array(z.string()).min(1),
      solutionFiles: z.array(z.string()).optional(),
      supportFiles: z.array(z.string()).default([]),
      testFile: z.string().default("tests.ts"),
    })
    .optional(),
  toolbox: z.array(ToolReference),
  checkpoint: Checkpoint.optional(),
  summary: StageSummary,
});

export class CurriculumError extends Error {
  override readonly name = "CurriculumError";
  constructor(readonly problems: string[]) {
    super("Invalid curriculum:\n- " + problems.join("\n- "));
  }
}

export function loadJourney(dir: string): Journey {
  const source = JourneySource.parse(readJson(join(dir, "journey.json")));
  const stages = source.stages.map((slug, index) =>
    loadStage(dir, source, slug, index + 1),
  );
  const journey: Journey = {
    id: source.id,
    title: source.title,
    description: source.description,
    repo: source.repo,
    status: "ready",
    concepts: source.concepts,
    stages,
  };
  const problems = validateJourney(journey);
  if (problems.length > 0) throw new CurriculumError(problems);
  return journey;
}

export function loadAllJourneys(root: string): Journey[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "journey.json")))
    .map((entry) => loadJourney(join(root, entry.name)));
}

function loadStage(
  dir: string,
  journey: z.infer<typeof JourneySource>,
  slug: string,
  order: number,
): Stage {
  const stageDir = join(dir, "stages", slug);
  const source = StageSource.parse(readJson(join(stageDir, "stage.json")));
  const code = (sub: string, path: string): CodeFile =>
    CodeFile.parse({ path, content: readFileSync(join(stageDir, sub, path), "utf8") });
  const reference = source.referenceCode.map((path) => code("reference", path));
  const id = `${journey.id}.${slug.slice(0, 2)}`;
  const exercise = source.exercise;

  return Stage.parse({
    id,
    order,
    title: source.title,
    ...(source.subtitle === undefined ? {} : { subtitle: source.subtitle }),
    goal: source.goal,
    problem: source.problem,
    estimatedMinutes: source.estimatedMinutes,
    introduces: source.introduces,
    prerequisites: source.prerequisites,
    architecture: source.architecture,
    referenceCode: reference,
    explanation: source.explanation,
    originalCodeRefs: source.originalCodeRefs.map((ref) => {
      const lines = readFileSync(join(dir, "original", ref.path), "utf8").split("\n");
      if (ref.endLine > lines.length || ref.startLine > ref.endLine) {
        throw new CurriculumError([`${id}: ${ref.path}:${ref.startLine}-${ref.endLine} out of range`]);
      }
      return {
        ...ref,
        snippet: lines.slice(ref.startLine - 1, ref.endLine).join("\n"),
        url: `${journey.repo.url}/blob/${journey.repo.sha}/${ref.path}#L${ref.startLine}-L${ref.endLine}`,
      };
    }),
    ...(exercise === undefined
      ? {}
      : {
          exercise: {
            instructions: exercise.instructions,
            starterFiles: exercise.starterFiles.map((path) => code("starter", path)),
            solutionFiles: (exercise.solutionFiles ?? exercise.starterFiles).map((path) =>
              code(existsSync(join(stageDir, "solution", path)) ? "solution" : "reference", path),
            ),
            supportFiles: exercise.supportFiles.map((path) => code("reference", path)),
            testFile: CodeFile.parse({
              path: exercise.testFile,
              content: readFileSync(join(stageDir, exercise.testFile), "utf8"),
            }),
          },
        }),
    toolbox: source.toolbox,
    tutorContext: {
      relevantFiles: [
        ...reference.map((file) => file.path),
        ...source.originalCodeRefs.map((ref) => ref.path),
      ],
      concepts: [...source.prerequisites, ...source.introduces],
      previousStages: journey.stages.slice(0, order - 1).map((s) => `${journey.id}.${s.slice(0, 2)}`),
    },
    completionCriteria: [{ kind: exercise ? "tests_pass" : "acknowledged" }],
    ...(source.checkpoint === undefined ? {} : { checkpoint: source.checkpoint }),
    summary: source.summary,
  });
}

/** Cross-stage invariants the schema alone cannot express. */
export function validateJourney(journey: Journey): string[] {
  const problems: string[] = [];
  const conceptIds = new Set(journey.concepts.map((concept) => concept.id));
  const introducedAt = new Map<string, number>();

  for (const stage of journey.stages) {
    const where = stage.id;
    for (const conceptId of stage.introduces) {
      if (!conceptIds.has(conceptId)) problems.push(`${where}: unknown concept ${conceptId}`);
      if (introducedAt.has(conceptId)) problems.push(`${where}: concept ${conceptId} introduced twice`);
      introducedAt.set(conceptId, stage.order);
    }
    for (const conceptId of stage.prerequisites) {
      const at = introducedAt.get(conceptId);
      if (at === undefined || at >= stage.order) {
        problems.push(`${where}: prerequisite ${conceptId} not introduced by an earlier stage`);
      }
    }
    for (const block of stage.explanation) {
      if (block.conceptId && !conceptIds.has(block.conceptId)) {
        problems.push(`${where}: explanation ${block.id} references unknown concept ${block.conceptId}`);
      }
    }
    const files = new Set(stage.referenceCode.map((file) => file.path));
    for (const ref of stage.originalCodeRefs) {
      if (!files.has(ref.replayFile)) problems.push(`${where}: ${ref.symbol} maps to missing ${ref.replayFile}`);
    }
    problems.push(...graphProblems(stage.architecture).map((problem) => `${where}: ${problem}`));
  }
  return problems;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
