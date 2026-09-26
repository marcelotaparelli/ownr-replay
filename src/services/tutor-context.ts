import type { Journey } from "../domain/journey.ts";
import type { Concept, Stage } from "../domain/stage.ts";
import type { TutorSelection } from "../domain/tutor.ts";

/**
 * Everything the tutor may know about "here and before", and nothing about
 * later stages: progression is part of the pedagogy.
 */
export type TutorContext = {
  journey: Journey;
  stage: Stage;
  previousStages: Stage[];
  /** Concepts introduced up to and including the current stage. */
  knownSoFar: Concept[];
  selection?: TutorSelection;
};

export function tutorContext(journey: Journey, stage: Stage, selection?: TutorSelection): TutorContext {
  const previousStages = journey.stages.filter((s) => s.order < stage.order);
  const introduced = new Set([...previousStages, stage].flatMap((s) => s.introduces));
  return {
    journey,
    stage,
    previousStages,
    knownSoFar: journey.concepts.filter((concept) => introduced.has(concept.id)),
    ...(selection ? { selection } : {}),
  };
}

export function systemPrompt(context: TutorContext): string {
  const { journey, stage, previousStages, knownSoFar } = context;
  const code = stage.referenceCode.map((file) => fence(file.path, file.content)).join("\n");
  const originals = stage.originalCodeRefs
    .map((ref) => `${ref.path}:${ref.startLine}-${ref.endLine} (${ref.symbol}) — ${ref.note}\n${fence(ref.path, ref.snippet)}`)
    .join("\n");
  const history = previousStages
    .map((s) => `- Stage ${s.order} "${s.title}": adicionou ${s.summary.added.join(", ")} — ${s.summary.why}`)
    .join("\n");

  return `Você é o tutor do Repo Replay. O desenvolvedor está reconstruindo o repositório ${journey.repo.owner}/${journey.repo.name} etapa por etapa para adquirir propriedade técnica sobre ele.

Regras:
- Responda em português, curto e direto (em geral 2 a 6 frases; código só se ajudar).
- Fale sobre ESTA etapa e as anteriores. Não antecipe conceitos de etapas futuras; se perguntarem, diga em uma frase que isso aparece mais adiante.
- Não entregue a solução do exercício pronta; explique o raciocínio e aponte a ferramenta certa.
- Quando útil, conecte com o projeto real citando caminho:linhas.
- Nada de respostas acadêmicas genéricas: use os nomes e o código desta etapa.

Etapa atual: Stage ${stage.order} — ${stage.title}
Objetivo: ${stage.goal}
Problema: ${stage.problem}
${history ? `\nEtapas anteriores:\n${history}\n` : ""}
Conceitos disponíveis até aqui: ${knownSoFar.map((c) => c.name).join(", ")}

Código pedagógico desta etapa:
${code}
${stage.exercise ? `\nExercício: ${stage.exercise.instructions}\n` : ""}
Código real correspondente (${journey.repo.sha.slice(0, 7)}):
${originals}`;
}

export function userPrompt(message: string, selection?: TutorSelection): string {
  if (!selection) return message;
  return `Trecho selecionado em ${selection.file}, linhas ${selection.startLine}-${selection.endLine}:\n${fence(selection.file, selection.text)}\n\n${message}`;
}

function fence(path: string, content: string): string {
  return "```ts // " + path + "\n" + content + "\n```";
}
