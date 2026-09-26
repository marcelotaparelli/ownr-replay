import { z } from "zod";
import { ArchitectureGraph } from "./architecture.ts";

export const ConceptGroup = z.enum(["Linguagem", "Domínio", "Arquitetura", "IA", "Infraestrutura"]);

/** A unit of knowledge the learner can own (or already own). */
export const Concept = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  group: ConceptGroup,
  /** Extra words the tutor uses to recognise the concept in a question or selection. */
  aliases: z.array(z.string()).default([]),
  quick: z.string().min(1),
  /** The problem it solves: what breaks if it is removed. */
  why: z.string().min(1),
});
export type Concept = z.infer<typeof Concept>;

export const CodeFile = z.strictObject({
  path: z.string().regex(/^[a-z0-9-]+\.ts$/),
  content: z.string(),
});
export type CodeFile = z.infer<typeof CodeFile>;

/** Always rendered Quick first; Normal and Deep only on demand. */
export const ExplanationBlock = z.strictObject({
  id: z.string().min(1),
  conceptId: z.string().optional(),
  title: z.string().min(1),
  quick: z.string().min(1),
  normal: z.string().min(1).optional(),
  deep: z.string().min(1).optional(),
});
export type ExplanationBlock = z.infer<typeof ExplanationBlock>;

export const ToolReference = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  signature: z.string().optional(),
  summary: z.string().min(1),
  example: z.string().min(1),
  whenToUse: z.string().optional(),
  complexity: z.string().optional(),
});
export type ToolReference = z.infer<typeof ToolReference>;

export const OriginalCodeReference = z.strictObject({
  /** Path inside the real repository. */
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  symbol: z.string().min(1),
  /** File of the pedagogical version this maps to. */
  replayFile: z.string().min(1),
  /** Declaration in the replay file, when its name differs from the production symbol. */
  replaySymbol: z.string().min(1).optional(),
  /** One or two lines: what is different in production and why. */
  note: z.string().min(1),
  snippet: z.string(),
  url: z.string().url(),
});
export type OriginalCodeReference = z.infer<typeof OriginalCodeReference>;

const Identifier = z.string().regex(/^[A-Za-z_$][\w$]*$/);

export const Exercise = z.strictObject({
  instructions: z.string().min(1),
  /** Files the learner writes. Micro stages and checkpoints start them empty: recall, not fill-in-the-blanks. */
  starterFiles: z.array(CodeFile).min(1),
  solutionFiles: z.array(CodeFile).min(1),
  /**
   * Read-only files holding what earlier steps already rebuilt (data tables, previous functions).
   * Their exports are auto-imported into the learner's files, so only the new idea gets rewritten.
   */
  supportFiles: z.array(CodeFile),
  /** Names the tests import from the learner's file; exported automatically when the learner omits `export`. */
  expose: z.array(Identifier),
  /** Owned by the server; the client never supplies tests. */
  testFile: CodeFile,
  /**
   * Present when types are what the stage teaches: learner + support files must pass the real
   * TypeScript checker, together with these type-level checks (never executed).
   */
  typecheck: z.strictObject({ files: z.array(CodeFile) }).optional(),
});
export type Exercise = z.infer<typeof Exercise>;

export const CompletionCriterion = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tests_pass") }),
  z.strictObject({ kind: z.literal("acknowledged") }),
]);

export const Checkpoint = z.strictObject({ question: z.string().min(1), answer: z.string().min(1) });

export const StageSummary = z.strictObject({
  added: z.array(z.string()).min(1),
  why: z.string().min(1),
  flow: z.array(z.string()).min(1),
});
export type StageSummary = z.infer<typeof StageSummary>;

/**
 * micro: one small idea; the solution is shown, then rebuilt from an empty editor.
 * checkpoint: the whole module rebuilt from scratch, then compared with the replay and the real code.
 * chapter: a larger stage not yet decomposed into micro stages (starter code allowed).
 */
export const StageKind = z.enum(["micro", "checkpoint", "chapter"]);
export type StageKind = z.infer<typeof StageKind>;

export const LineNote = z.strictObject({ match: z.string().min(1), note: z.string().min(1) });

/** An input → output example. Both sides are TypeScript expressions, executed against the solution by the validator. */
export const IoExample = z.strictObject({ expr: z.string().min(1), equals: z.string().min(1) });
export type IoExample = z.infer<typeof IoExample>;
export type LineNote = z.infer<typeof LineNote>;

export const Stage = z.strictObject({
  id: z.string().min(1),
  order: z.number().int().positive(),
  moduleId: z.string().min(1),
  kind: StageKind,
  title: z.string().min(1),
  subtitle: z.string().optional(),
  goal: z.string().min(1),
  problem: z.string().min(1),
  /** Concrete input → output: says WHAT is expected, never HOW. Verified by execution. */
  examples: z.array(IoExample),
  /** Plain-language requirements (checkpoints): what to rebuild, not code. */
  requirements: z.array(z.string().min(1)),
  /** Why this step exceeds the novelty budget, when it must (otherwise: decompose). */
  noveltyException: z.string().min(1).optional(),
  estimatedMinutes: z.number().int().positive(),
  /** Concept ids introduced here. */
  introduces: z.array(z.string()),
  /** Concept ids from earlier stages this stage leans on. */
  prerequisites: z.array(z.string()),
  architecture: ArchitectureGraph.optional(),
  referenceCode: z.array(CodeFile).min(1),
  /** Shown when the learner clicks a solution line containing `match`. */
  lineNotes: z.array(LineNote),
  explanation: z.array(ExplanationBlock),
  originalCodeRefs: z.array(OriginalCodeReference),
  exercise: Exercise.optional(),
  toolbox: z.array(ToolReference),
  tutorContext: z.strictObject({
    relevantFiles: z.array(z.string()),
    concepts: z.array(z.string()),
    previousStages: z.array(z.string()),
  }),
  completionCriteria: z.array(CompletionCriterion).min(1),
  checkpoint: Checkpoint.optional(),
  /** The perceptible limitation that motivates the next step. */
  limitation: z.string().optional(),
  summary: StageSummary.optional(),
});
export type Stage = z.infer<typeof Stage>;

/** A chapter of the journey; the sidebar groups its stages under it. */
export const Module = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  stageIds: z.array(z.string()).min(1),
});
export type Module = z.infer<typeof Module>;
