import type { Concept, OriginalCodeReference, ToolReference } from "../domain/stage.ts";
import type { TutorContext } from "./tutor-context.ts";

/**
 * Deterministic tutor used when no LLM is configured (or it fails).
 * It only recombines the stage's own material, so it can be wrong by
 * omission but never by invention — and it respects stage progression.
 */
export function offlineAnswer(context: TutorContext, message: string): string {
  const { stage, journey, knownSoFar, selection } = context;
  const question = fold(message);
  const selected = fold(selection?.text ?? "");
  const haystack = `${selected} ${question}`;

  const future = futureConcept(context, question);
  const concept = best(knownSoFar, (c) => [c.name, c.id, ...c.aliases], selected, question);
  const tool = best(stage.toolbox, (t) => [t.name, t.id], selected, question);
  const wantsOriginal = /\b(onde|projeto real|original|producao|repo)\b/.test(question);
  const wantsWhatIf = /(o que acontece se|\bsem\b|remov|tirar|nao existisse|precisa|precisamos|por que|pq|why)/.test(question);
  const wantsDepth = /(aprofund|detalh|explique melhor|mais)/.test(question);

  if (future && !concept) {
    const at = journey.stages.find((s) => s.introduces.includes(future.id));
    return `**${future.name}** aparece mais adiante${at ? ` (Stage ${String(at.order).padStart(2, "0")} — ${at.title})` : ""}. Por enquanto, o foco é: ${stage.goal}`;
  }

  if (wantsOriginal && !concept && !tool) return originalAnswer(stage.originalCodeRefs);

  const parts: string[] = [];
  if (concept) {
    parts.push(`**${concept.name}** — ${concept.quick}`);
    if (wantsWhatIf || !tool) parts.push(`**Sem isso:** ${concept.why}`);
    const block = stage.explanation.find((b) => b.conceptId === concept.id);
    if (block && (wantsDepth || selected)) parts.push(block.normal);
    const ref = relatedRef(stage.originalCodeRefs, concept, haystack);
    if (ref) parts.push(`No projeto real: \`${ref.path}:${ref.startLine}-${ref.endLine}\` (${ref.symbol}). ${ref.note}`);
  }
  if (tool && (!concept || rank(tool.name, selected) > 0)) parts.push(toolAnswer(tool));
  if (parts.length > 0) return parts.join("\n\n");

  if (wantsOriginal) return originalAnswer(stage.originalCodeRefs);

  const introduced = knownSoFar.filter((c) => stage.introduces.includes(c.id)).map((c) => c.name);
  return [
    `Nesta etapa o foco é: ${stage.goal}`,
    `Posso explicar: ${introduced.join(", ")}.`,
    "Dica: selecione um trecho do código e clique em **Explain** — eu respondo sobre exatamente aquele trecho.",
  ].join("\n\n");
}

function best<T>(items: T[], names: (item: T) => string[], selected: string, question: string): T | undefined {
  let winner: T | undefined;
  let winnerScore = 0;
  for (const item of items) {
    // A match inside the selected code outweighs a match in the question.
    const score = Math.max(...names(item).map((name) => rank(name, selected) * 2 + rank(name, question)));
    if (score > winnerScore) {
      winner = item;
      winnerScore = score;
    }
  }
  return winner;
}

/** Longer matched names are more specific, so they score higher. */
function rank(name: string, text: string): number {
  const needle = fold(name);
  if (needle.length < 2 || !text) return 0;
  const pattern = new RegExp(`(^|[^a-z0-9_])${escape(needle)}($|[^a-z0-9_])`);
  return pattern.test(text) ? needle.length : 0;
}

function futureConcept(context: TutorContext, question: string): Concept | undefined {
  const known = new Set(context.knownSoFar.map((c) => c.id));
  const later = context.journey.concepts.filter((c) => !known.has(c.id));
  return best(later, (c) => [c.name, ...c.aliases.filter((alias) => alias.length >= 4)], "", question);
}

function relatedRef(refs: OriginalCodeReference[], concept: Concept, haystack: string): OriginalCodeReference | undefined {
  const words = [concept.name, ...concept.aliases].map(fold).filter((word) => word.length >= 3);
  // The concept itself is the strongest signal (TIE_BREAK ↔ CATEGORY_TIE_BREAK); incidental
  // words in the selection (e.g. a "Category" type annotation) come after.
  return (
    refs.find((ref) => words.some((word) => fold(ref.symbol).includes(word))) ??
    refs.find((ref) => rank(ref.symbol, haystack) > 0) ??
    refs.find((ref) => words.some((word) => fold(ref.snippet).includes(word)))
  );
}

function toolAnswer(tool: ToolReference): string {
  return [
    `**${tool.name}**${tool.signature ? ` — \`${tool.signature}\`` : ""}`,
    tool.summary,
    "```ts\n" + tool.example + "\n```",
  ].join("\n\n");
}

function originalAnswer(refs: OriginalCodeReference[]): string {
  if (refs.length === 0) return "Esta etapa não tem correspondência direta no repositório real.";
  return (
    "No projeto real:\n\n" +
    refs.map((ref) => `- \`${ref.path}:${ref.startLine}-${ref.endLine}\` **${ref.symbol}** — ${ref.note}`).join("\n")
  );
}

function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
