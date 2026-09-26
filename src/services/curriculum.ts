import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { graphProblems } from "../domain/architecture-diff.ts";
import { ArchitectureGraph } from "../domain/architecture.ts";
import type { Journey } from "../domain/journey.ts";
import {
  Checkpoint,
  CodeFile,
  Concept,
  ExplanationBlock,
  LineNote,
  OriginalCodeReference,
  Stage,
  StageKind,
  StageSummary,
  ToolReference,
  type Module,
} from "../domain/stage.ts";

/**
 * Loads hand-authored journeys from disk. Layout per journey:
 *   journey.json                   modules → stage paths, concept catalog
 *   original/<repo path>           files copied from the real repo at `repo.sha`
 *   stages/<path>/stage.json       pedagogy (path: "NN-slug" or "<module>/NN-slug")
 *   stages/<path>/reference/       the solution shown to the learner
 *   stages/<path>/starter/         chapters only: exercise starting point (micro stages start empty)
 *   stages/<path>/given/           read-only files the exercise builds on (defaults to reference/)
 *   stages/<path>/solution/        optional; defaults to reference/
 *   stages/<path>/tests.ts         tests run against the learner's files
 * The future Stage Generator will produce the same `Journey` shape.
 */

const StagePath = z.string().regex(/^(?:[a-z0-9-]+\/)?\d{2}-[a-z0-9-]+$/);

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
  modules: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]+$/),
        title: z.string().min(1),
        subtitle: z.string().optional(),
        stages: z.array(StagePath).min(1),
      }),
    )
    .min(1),
  concepts: z.array(Concept).min(1),
});
type JourneySource = z.infer<typeof JourneySource>;

const StageSource = z.strictObject({
  kind: StageKind.default("chapter"),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  goal: z.string().min(1),
  problem: z.string().min(1),
  example: z.string().optional(),
  estimatedMinutes: z.number().int().positive(),
  introduces: z.array(z.string()),
  prerequisites: z.array(z.string()),
  architecture: ArchitectureGraph.optional(),
  referenceCode: z.array(z.string()).min(1),
  lineNotes: z.array(LineNote).default([]),
  explanation: z.array(ExplanationBlock),
  originalCodeRefs: z.array(OriginalCodeReference.omit({ snippet: true, url: true })).default([]),
  exercise: z
    .strictObject({
      instructions: z.string().min(1),
      files: z.array(z.string()).min(1),
      solutionFiles: z.array(z.string()).optional(),
      supportFiles: z.array(z.string()).default([]),
      expose: z.array(z.string()).default([]),
      testFile: z.string().default("tests.ts"),
    })
    .optional(),
  toolbox: z.array(ToolReference),
  checkpoint: Checkpoint.optional(),
  limitation: z.string().optional(),
  summary: StageSummary.optional(),
});

export class CurriculumError extends Error {
  override readonly name = "CurriculumError";
  constructor(readonly problems: string[]) {
    super("Invalid curriculum:\n- " + problems.join("\n- "));
  }
}

export function loadJourney(dir: string): Journey {
  const source = JourneySource.parse(readJson(join(dir, "journey.json")));
  const paths = source.modules.flatMap((module) => module.stages.map((path) => ({ module: module.id, path })));
  const ids = paths.map(({ module, path }) => stageId(source.id, module, path));
  const stages = paths.map(({ module, path }, index) => loadStage(dir, source, module, path, index + 1, ids.slice(0, index)));
  const modules: Module[] = source.modules.map((module) => ({
    id: module.id,
    title: module.title,
    ...(module.subtitle === undefined ? {} : { subtitle: module.subtitle }),
    stageIds: stages.filter((s) => s.moduleId === module.id).map((s) => s.id),
  }));
  const journey: Journey = {
    id: source.id,
    title: source.title,
    description: source.description,
    repo: source.repo,
    status: "ready",
    concepts: source.concepts,
    modules,
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

/** Nested micro stages get "<module>-NN"; top-level chapters keep their historical "NN" ids. */
function stageId(journeyId: string, moduleId: string, path: string): string {
  const number = basename(path).slice(0, 2);
  return path.includes("/") ? `${journeyId}.${moduleId}-${number}` : `${journeyId}.${number}`;
}

function loadStage(dir: string, journey: JourneySource, moduleId: string, path: string, order: number, previousStages: string[]): Stage {
  const stageDir = join(dir, "stages", path);
  const source = StageSource.parse(readJson(join(stageDir, "stage.json")));
  const read = (sub: string, file: string): CodeFile => CodeFile.parse({ path: file, content: readFileSync(join(stageDir, sub, file), "utf8") });
  const readFirst = (subs: string[], file: string): CodeFile => {
    const sub = subs.find((candidate) => existsSync(join(stageDir, candidate, file))) ?? subs.at(-1) ?? "reference";
    return read(sub, file);
  };
  const reference = source.referenceCode.map((file) => read("reference", file));
  const id = stageId(journey.id, moduleId, path);
  const exercise = source.exercise;

  return Stage.parse({
    id,
    order,
    moduleId,
    kind: source.kind,
    title: source.title,
    ...(source.subtitle === undefined ? {} : { subtitle: source.subtitle }),
    goal: source.goal,
    problem: source.problem,
    ...(source.example === undefined ? {} : { example: source.example }),
    estimatedMinutes: source.estimatedMinutes,
    introduces: source.introduces,
    prerequisites: source.prerequisites,
    ...(source.architecture === undefined ? {} : { architecture: source.architecture }),
    referenceCode: reference,
    lineNotes: source.lineNotes,
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
            // Micro stages and checkpoints have no starter/ directory: the editor starts empty.
            starterFiles: exercise.files.map((file) =>
              existsSync(join(stageDir, "starter", file)) ? read("starter", file) : { path: file, content: "" },
            ),
            solutionFiles: (exercise.solutionFiles ?? exercise.files).map((file) => readFirst(["solution", "reference"], file)),
            supportFiles: exercise.supportFiles.map((file) => readFirst(["given", "reference"], file)),
            expose: exercise.expose,
            testFile: CodeFile.parse({ path: exercise.testFile, content: readFileSync(join(stageDir, exercise.testFile), "utf8") }),
          },
        }),
    toolbox: source.toolbox,
    tutorContext: {
      relevantFiles: [...reference.map((file) => file.path), ...source.originalCodeRefs.map((ref) => ref.path)],
      concepts: [...source.prerequisites, ...source.introduces],
      previousStages,
    },
    completionCriteria: [{ kind: exercise ? "tests_pass" : "acknowledged" }],
    ...(source.checkpoint === undefined ? {} : { checkpoint: source.checkpoint }),
    ...(source.limitation === undefined ? {} : { limitation: source.limitation }),
    ...(source.summary === undefined ? {} : { summary: source.summary }),
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
    if (stage.architecture) problems.push(...graphProblems(stage.architecture).map((problem) => `${where}: ${problem}`));
    // The core pedagogical rule: rebuilding starts from a blank editor.
    if (stage.kind !== "chapter" && stage.exercise?.starterFiles.some((file) => file.content.trim() !== "")) {
      problems.push(`${where}: ${stage.kind} stages must not ship starter code`);
    }
    if (stage.kind === "micro" && !stage.limitation && stage.order < journey.stages.length) {
      problems.push(`${where}: micro stages must name the limitation that motivates the next step`);
    }
  }
  return problems;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
