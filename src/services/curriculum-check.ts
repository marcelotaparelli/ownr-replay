import { noveltyLines } from "../domain/line-diff.ts";
import type { Stage } from "../domain/stage.ts";
import type { TypeChecker } from "../sandbox/typecheck.ts";

/**
 * Curriculum gates that need more than the schema: shown snippets must be valid programs,
 * and micro steps must stay small. Used by the golden validation (bun test) and, later,
 * by the Stage Validator for generated journeys.
 */

export type Snippet = { where: string; code: string };

const FENCE = /```ts[^\n]*\n([\s\S]*?)```/g;

/** Code the learner sees outside the solution: toolbox examples and fenced blocks in explanations. */
export function shownSnippets(stages: Stage[]): Snippet[] {
  return stages.flatMap((s) => [
    ...s.toolbox.map((t) => ({ where: `${s.id} toolbox "${t.name}"`, code: t.example })),
    ...s.explanation.flatMap((b) =>
      [b.quick, b.normal ?? "", b.deep ?? ""].flatMap((text) =>
        [...text.matchAll(FENCE)].map((m) => ({ where: `${s.id} explanation "${b.title}"`, code: m[1] ?? "" })),
      ),
    ),
  ]);
}

/** Each snippet is type-checked as its own module; returns "where: TSxxxx message" for every problem. */
export async function snippetProblems(snippets: Snippet[], checker: TypeChecker): Promise<string[]> {
  if (snippets.length === 0) return [];
  const files = snippets.map((s, i) => ({ path: `snippet-${i}.ts`, content: `${s.code}\nexport {};\n` }));
  const diagnostics = await checker.check(files);
  return diagnostics.map((d) => `${snippets[Number(d.file.replace(/\D/g, ""))]?.where ?? d.file} (linha ${d.line}): ${d.code} ${d.message}`);
}

export type NoveltyRow = { stageId: string; title: string; newLines: number; exception?: string };

/** Relevant new lines per micro stage, against the previous micro stage of the same module. */
export function noveltyReport(stages: Stage[]): NoveltyRow[] {
  return stages.flatMap((stage, index) => {
    if (stage.kind !== "micro" || !stage.exercise) return [];
    const previous = stages[index - 1];
    const sameModule = previous?.kind === "micro" && previous.moduleId === stage.moduleId ? previous : undefined;
    const before = sameModule?.exercise?.solutionFiles[0]?.content ?? "";
    const after = stage.exercise.solutionFiles[0]?.content ?? "";
    return [{ stageId: stage.id, title: stage.title, newLines: noveltyLines(before, after).length, ...(stage.noveltyException ? { exception: stage.noveltyException } : {}) }];
  });
}
