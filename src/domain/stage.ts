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
  normal: z.string().min(1),
  deep: z.string().min(1),
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
  /** One or two lines: what is different in production and why. */
  note: z.string().min(1),
  snippet: z.string(),
  url: z.string().url(),
});
export type OriginalCodeReference = z.infer<typeof OriginalCodeReference>;

export const Exercise = z.strictObject({
  instructions: z.string().min(1),
  starterFiles: z.array(CodeFile).min(1),
  solutionFiles: z.array(CodeFile).min(1),
  /** Owned by the server; the client never supplies tests. */
  testFile: CodeFile,
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

export const Stage = z.strictObject({
  id: z.string().min(1),
  order: z.number().int().positive(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  goal: z.string().min(1),
  problem: z.string().min(1),
  estimatedMinutes: z.number().int().positive(),
  /** Concept ids introduced here. */
  introduces: z.array(z.string()),
  /** Concept ids from earlier stages this stage leans on. */
  prerequisites: z.array(z.string()),
  architecture: ArchitectureGraph,
  referenceCode: z.array(CodeFile).min(1),
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
  summary: StageSummary,
});
export type Stage = z.infer<typeof Stage>;
