import type { JourneyOutline, StageOutline } from "../src/domain/journey.ts";
import type { RunResult } from "../src/domain/progress.ts";
import type { CodeFile, Concept, ExplanationBlock, IoExample, Module, OriginalCodeReference } from "../src/domain/stage.ts";
import type { TutorSelection } from "../src/domain/tutor.ts";
import { api, type StageDetail } from "./api.ts";
import { architectureView } from "./arch.ts";
import { addedLines } from "../src/domain/line-diff.ts";
import { codeView, selectionFromCodeView } from "./code-view.ts";
import { h } from "./dom.ts";
import { createEditor, type Editor } from "./editor.ts";
import { md } from "./md.ts";
import { runExercise } from "./runner.ts";
import { acceptedCode, drafts, reportSyncFailure, type ProgressStore } from "./store.ts";

export type StageActions = {
  complete(): void;
  skipKnown(): void;
  skip(): void;
  /** Mark the module's remaining micro stages as known and jump to its checkpoint. */
  skipModule(): void;
  goto(order: number): void;
  explain(selection: TutorSelection): void;
};

export type StageViewDeps = {
  journey: JourneyOutline;
  stage: StageDetail;
  /** The stage right before this one (any module). */
  previous: StageDetail | undefined;
  module: Module;
  moduleStages: StageOutline[];
  store: ProgressStore;
  actions: StageActions;
};

type Depth = "quick" | "normal" | "deep";

export type MountedStage = { element: HTMLElement; run(): void; editorSelection(): TutorSelection | undefined };

export function renderStage(deps: StageViewDeps): MountedStage {
  if (deps.stage.kind === "micro") return renderMicro(deps);
  if (deps.stage.kind === "checkpoint") return renderCheckpoint(deps);
  return renderChapter(deps);
}

// ---------------------------------------------------------------- micro stage
// PROBLEMA → SOLUÇÃO MÍNIMA → ENTENDA → RECONSTRUA (solution hidden) → TESTE → NOVA LIMITAÇÃO

function renderMicro(deps: StageViewDeps): MountedStage {
  const { stage, actions } = deps;
  const limitation = stage.limitation
    ? h(
        "aside",
        { class: "limitation", hidden: true, "aria-live": "polite" },
        h("p", { class: "eyebrow" }, "Nova limitação"),
        h("div", { html: md(stage.limitation) }),
        h("button", { type: "button", class: "btn primary", onclick: actions.complete }, isLastOfModule(deps) ? "Ir para o checkpoint →" : "Próxima etapa →"),
      )
    : null;
  const exercise = buildExercise(deps, {
    start: startingPoint(deps),
    onPass: () => {
      if (!limitation) return;
      limitation.hidden = false;
      // Centered: the sticky action bar would otherwise cover it.
      limitation.scrollIntoView({ block: "center" });
    },
  });

  const study = h(
    "div",
    { class: "study" },
    section("solucao", "Solução mínima", solution(deps), architectureIfChanged(deps)),
    stage.explanation.length ? section("entenda", "Entenda", ...stage.explanation.map((block) => explanationBlock(block, deps))) : null,
  );
  const rebuild = exercise ? section("reconstrua", "Reconstrua", exercise.element) : null;
  if (rebuild) rebuild.hidden = true;

  const startRebuild = h("button", { type: "button", class: "btn primary rebuild-start" }, "Agora reconstrua →");
  const peek = h("button", { type: "button", class: "link" }, "Mostrar solução");
  const opened = performance.now();
  startRebuild.addEventListener("click", () => {
    if (!rebuild) return actions.complete();
    // Recall, not copy: the solution leaves the screen while rebuilding.
    study.hidden = true;
    startRebuild.hidden = true;
    rebuild.hidden = false;
    rebuild.scrollIntoView({ block: "start" });
    exercise?.focus();
    api.event(stage.id, "reconstruct_started", { msSinceOpen: Math.round(performance.now() - opened) }).catch(reportSyncFailure);
  });
  peek.addEventListener("click", () => {
    study.hidden = !study.hidden;
    peek.textContent = study.hidden ? "Mostrar solução" : "Esconder solução";
    if (!study.hidden) api.event(stage.id, "solution_revealed").catch(reportSyncFailure);
  });
  exercise?.toolbar.append(peek);

  const element = h(
    "article",
    { class: "stage micro", "aria-labelledby": "stage-title" },
    microHeader(deps),
    section("problema", "Problema", h("div", { class: "problem", html: md(stage.problem) }), examplesBox(stage.examples)),
    study,
    rebuild ? startRebuild : null,
    rebuild,
    limitation,
    actionBar(deps),
  );
  trackAnchors(element, stage.id, deps.store);
  attachExplainButton(element, actions, () => exercise?.selection());
  return { element, run: () => exercise?.run(), editorSelection: () => exercise?.selection() };
}

function microHeader(deps: StageViewDeps): HTMLElement {
  const { stage, module, moduleStages, store, actions } = deps;
  const micro = moduleStages.filter((s) => s.kind === "micro");
  const index = micro.findIndex((s) => s.id === stage.id) + 1;
  return h(
    "header",
    { class: "stage-head" },
    h("div", { class: "head-row" },
      h("p", { class: "eyebrow" }, `${module.title} · ${index} de ${micro.length} · ~${stage.estimatedMinutes} min`, statusPill(store.status(stage.id))),
      h("button", { type: "button", class: "btn ghost small", onclick: actions.skipKnown, title: "Marcar como dominada e avançar" }, "Já sei isso → pular"),
    ),
    h("h1", { id: "stage-title" }, stage.title),
    stage.subtitle ? h("p", { class: "subtitle" }, stage.subtitle) : null,
    h("button", { type: "button", class: "link module-skip", onclick: actions.skipModule }, "Já domino este módulo → ir ao checkpoint"),
  );
}

/** The previous micro stage of the same module: the state this step changes. */
function previousMicro({ stage, previous }: StageViewDeps): StageDetail | undefined {
  return previous?.kind === "micro" && previous.moduleId === stage.moduleId ? previous : undefined;
}

function solution(deps: StageViewDeps): HTMLElement {
  const { stage } = deps;
  const before = previousMicro(deps);
  const note = h("p", { class: "line-note", "aria-live": "polite" }, "Clique em uma linha para ver o que ela faz.");
  const tabs = stage.referenceCode.map((file) => ({
    label: file.path,
    render: () =>
      codeView(file.path, file.content, {
        // Green = the real delta from the previous step's solution (the first step is all new).
        newLines: new Set(addedLines(before?.referenceCode.find((f) => f.path === file.path)?.content ?? "", file.content)),
        onLine: (line, text) => {
          const match = stage.lineNotes.find((n) => text.includes(n.match));
          note.innerHTML = match ? md(`**Linha ${line}.** ${match.note}`) : `Linha ${line}.`;
        },
      }),
  }));
  return h("div", {}, fileTabs(tabs), note, h("p", { class: "muted legend" }, h("span", { class: "dot-new" }), before ? " só o que mudou em relação à etapa anterior" : " o programa inteiro é novo nesta primeira etapa"));
}

function architectureIfChanged({ stage, previous }: StageViewDeps): HTMLElement | null {
  if (!stage.architecture) return null;
  const before = previous?.architecture;
  const unchanged =
    before &&
    JSON.stringify(before.nodes.map((n) => [n.id, n.label])) === JSON.stringify(stage.architecture.nodes.map((n) => [n.id, n.label])) &&
    before.edges.length === stage.architecture.edges.length;
  return unchanged ? null : architectureView(stage.architecture, before);
}

/** Examples are executed against the solution by the curriculum validator: they are true by construction. */
function examplesBox(examples: IoExample[]): HTMLElement | null {
  if (examples.length === 0) return null;
  const text = examples.map((e) => `${e.expr}\n→ ${e.equals}`).join("\n\n");
  return h("div", { class: "example" }, h("p", { class: "eyebrow" }, examples.length > 1 ? "Exemplos" : "Exemplo"), h("pre", {}, text));
}

function requirementsBox(requirements: string[]): HTMLElement | null {
  if (requirements.length === 0) return null;
  return h("div", { class: "example" }, h("p", { class: "eyebrow" }, "Requisitos"), h("ul", { class: "requirements" }, ...requirements.map((r) => h("li", { html: md(r).replace(/^<p>|<\/p>$/g, "") }))));
}

type StartingPoint = { files: CodeFile[]; origin: "empty" | "own" | "reference"; referenceFiles?: CodeFile[] };

/**
 * Micro stages continue the learner's own program: the code they got accepted in the previous
 * step. Only when there is none (the step was skipped) do we fall back to that step's
 * reference solution — and say so, never silently.
 */
function startingPoint(deps: StageViewDeps): StartingPoint | undefined {
  const exercise = deps.stage.exercise;
  const before = previousMicro(deps);
  if (!exercise || !before) return undefined;
  const accepted = acceptedCode(before.id);
  const own = exercise.starterFiles.map((f) => ({ path: f.path, content: accepted.load(f.path) }));
  if (own.every((f) => f.content !== undefined)) {
    return { files: own.map((f) => ({ path: f.path, content: f.content ?? "" })), origin: "own", referenceFiles: exercise.starterFiles };
  }
  return { files: exercise.starterFiles, origin: "reference" };
}

function isLastOfModule({ stage, moduleStages }: StageViewDeps): boolean {
  const micro = moduleStages.filter((s) => s.kind === "micro");
  return micro.at(-1)?.id === stage.id;
}

// ---------------------------------------------------------------- checkpoint
// Rebuild everything from an empty editor, then: yours ↔ consolidated replay ↔ real code.

function renderCheckpoint(deps: StageViewDeps): MountedStage {
  const { stage, module } = deps;
  const compare = section("comparar", "Compare", h("div"));
  compare.hidden = true;
  let exercise: ExerciseView | undefined;
  const showCompare = (): void => {
    compare.replaceChildren(h("h2", {}, "Compare"), comparison(stage, () => exercise?.values() ?? []));
    compare.hidden = false;
    compare.scrollIntoView({ block: "start" });
  };
  exercise = buildExercise(deps, { onPass: showCompare });
  exercise?.toolbar.append(h("button", { type: "button", class: "link", onclick: showCompare }, "Comparar agora"));

  const element = h(
    "article",
    { class: "stage checkpoint", "aria-labelledby": "stage-title" },
    h("header", { class: "stage-head" },
      h("p", { class: "eyebrow" }, `${module.title} · Checkpoint · ~${stage.estimatedMinutes} min`, statusPill(deps.store.status(stage.id))),
      h("h1", { id: "stage-title" }, stage.title),
      stage.subtitle ? h("p", { class: "subtitle" }, stage.subtitle) : null,
    ),
    section("problema", "Problema", h("div", { class: "problem", html: md(stage.problem) }), requirementsBox(stage.requirements), examplesBox(stage.examples)),
    exercise ? section("reconstrua", "Reconstrua do zero", exercise.element) : null,
    compare,
    actionBar(deps, "✓ Concluir módulo"),
  );
  trackAnchors(element, stage.id, deps.store);
  attachExplainButton(element, deps.actions, () => exercise?.selection());
  return { element, run: () => exercise?.run(), editorSelection: () => exercise?.selection() };
}

function comparison(stage: StageDetail, yours: () => CodeFile[]): HTMLElement {
  const tabs: Tab[] = [
    ...yours().map((file) => ({ label: `Sua versão · ${file.path}`, render: () => codeView(file.path, file.content || "// (vazio)") })),
    ...stage.referenceCode.map((file) => ({ label: `Replay consolidado · ${file.path}`, render: () => codeView(file.path, file.content) })),
  ];
  return h(
    "div",
    { class: "comparison" },
    fileTabs(tabs),
    stage.originalCodeRefs.length ? h("div", {}, h("h3", {}, "No código real"), originalRefs(stage)) : null,
    ...stage.explanation.map((block) => explanationBlock(block, { stage })),
    stage.checkpoint ? h("div", {}, h("h3", {}, "Checar entendimento"), checkpoint(stage)) : null,
  );
}

// ---------------------------------------------------------------- chapter (not yet decomposed)

function renderChapter(deps: StageViewDeps): MountedStage {
  const { journey, stage, store, actions } = deps;
  const concepts = new Map(journey.concepts.map((c) => [c.id, c]));
  const exercise = buildExercise(deps, { allowSolution: true });

  const element = h(
    "article",
    { class: "stage", "aria-labelledby": "stage-title" },
    h("header", { class: "stage-head" },
      h("p", { class: "eyebrow" }, `${deps.module.title} · ~${stage.estimatedMinutes} min`, statusPill(store.status(stage.id))),
      h("h1", { id: "stage-title" }, stage.title),
      stage.subtitle ? h("p", { class: "subtitle" }, stage.subtitle) : null,
    ),
    justCompletedCard(deps),
    fastPath(deps, concepts),
    prerequisiteNotice(deps, concepts),
    section("contexto", "Contexto",
      h("p", { class: "problem" }, stage.problem),
      h("p", { class: "goal" }, h("strong", {}, "Objetivo: "), stage.goal),
    ),
    section("codigo", "Código pronto", fileTabs(stage.referenceCode.map((f) => ({ label: f.path, render: () => codeView(f.path, f.content) })))),
    stage.architecture ? section("arquitetura", "Arquitetura", architectureView(stage.architecture, deps.previous?.architecture)) : null,
    section("conceitos", "Conceitos", ...stage.explanation.map((block) => explanationBlock(block, deps, block.conceptId ? concepts.get(block.conceptId) : undefined))),
    stage.originalCodeRefs.length ? section("projeto-real", "No projeto real", originalRefs(stage)) : null,
    exercise ? section("reconstrua", "Reconstrua", exercise.element) : null,
    stage.checkpoint ? section("checagem", "Checar entendimento", checkpoint(stage)) : null,
    actionBar(deps),
  );

  trackAnchors(element, stage.id, store);
  attachExplainButton(element, actions, () => exercise?.selection());
  return { element, run: () => exercise?.run(), editorSelection: () => exercise?.selection() };
}

function justCompletedCard({ journey, stage, store }: StageViewDeps): HTMLElement | null {
  const id = store.consumeJustCompleted();
  const done = journey.stages.find((s) => s.id === id);
  const summary = done?.summary;
  if (!done || !summary || done.order !== stage.order - 1) return null;
  const card = h(
    "aside",
    { class: "summary-card", "aria-label": "Resumo da etapa anterior" },
    h("p", { class: "eyebrow" }, `${done.title} · consolidada`),
    h("p", {}, h("strong", {}, "Você adicionou: "), summary.added.join(", ")),
    h("p", {}, h("strong", {}, "Por quê: "), summary.why),
    h("p", { class: "flow" }, summary.flow.join("  →  ")),
    h("button", { type: "button", class: "link", onclick: () => card.remove() }, "Ok"),
  );
  return card;
}

/** Offer to skip a stage whose concepts the learner may already own. */
function fastPath({ stage, store, actions }: StageViewDeps, concepts: Map<string, Concept>): HTMLElement | null {
  const status = store.status(stage.id);
  if (status === "completed" || status === "skipped_known" || stage.introduces.length === 0) return null;
  const pending = stage.introduces.filter((id) => !store.isKnown(id)).map((id) => concepts.get(id)?.name ?? id);
  if (pending.length === 0) {
    return h("aside", { class: "fastpath known" },
      h("p", {}, "Você já marcou todos os conceitos desta etapa como conhecidos."),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn", onclick: actions.skipKnown }, "Pular etapa"),
        h("button", { type: "button", class: "link", onclick: (e) => (e.currentTarget as HTMLElement).closest("aside")?.remove() }, "Revisar mesmo assim"),
      ),
    );
  }
  const box = h(
    "aside",
    { class: "fastpath", "aria-label": "Fast Path" },
    h("p", {}, "Você já domina ", h("strong", {}, list(pending)), "?"),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn", onclick: actions.skipKnown }, "Sim, pular etapa"),
      h("button", { type: "button", class: "btn ghost", onclick: () => box.remove() }, "Revisar rápido"),
      h("button", {
        type: "button",
        class: "btn ghost",
        onclick: () => {
          box.closest(".stage")?.querySelectorAll<HTMLButtonElement>("[data-depth='deep']").forEach((b) => b.click());
          box.remove();
        },
      }, "Entender a fundo"),
    ),
  );
  return box;
}

function prerequisiteNotice({ journey, stage, store, actions }: StageViewDeps, concepts: Map<string, Concept>): HTMLElement | null {
  const skipped = stage.prerequisites
    .map((conceptId) => ({ conceptId, at: journey.stages.find((s) => s.introduces.includes(conceptId)) }))
    .filter(({ conceptId, at }) => at && store.status(at.id) === "skipped" && !store.isKnown(conceptId));
  const first = skipped[0];
  if (!first?.at) return null;
  const at = first.at;
  const box = h(
    "aside",
    { class: "notice" },
    h("p", {}, `Esta etapa usa ${concepts.get(first.conceptId)?.name ?? first.conceptId}, vista em "${at.title}".`),
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn ghost", onclick: () => actions.goto(at.order) }, "Revisar rapidamente"),
      h("button", { type: "button", class: "link", onclick: () => box.remove() }, "Continuar"),
    ),
  );
  return box;
}

// ---------------------------------------------------------------- shared pieces

function statusPill(status: string): HTMLElement | null {
  const label: Record<string, string> = { completed: "concluída", skipped_known: "já dominada", skipped: "pulada" };
  const text = label[status];
  return text ? h("span", { class: `pill ${status}` }, text) : null;
}

function section(anchor: string, title: string, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "block", id: anchor, "data-anchor": title }, h("h2", {}, title), ...children);
}

type Tab = { label: string; render: () => HTMLElement; extraClass?: string };

function fileTabs(tabs: Tab[]): HTMLElement {
  const body = h("div", { class: "tab-body" });
  const bar = h("div", { class: "tabs", role: "tablist" });
  const select = (index: number): void => {
    const tab = tabs[index];
    if (!tab) return;
    bar.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-selected", String(i === index)));
    body.replaceChildren(tab.render());
  };
  tabs.forEach((tab, index) => bar.append(h("button", { type: "button", role: "tab", class: tab.extraClass ?? "", onclick: () => select(index) }, tab.label)));
  select(0);
  return h("div", { class: "files" }, tabs.length > 1 ? bar : h("div", { class: "tabs single" }, h("span", {}, tabs[0]?.label ?? "")), body);
}

function explanationBlock(block: ExplanationBlock, deps: Pick<StageViewDeps, "stage"> & Partial<Pick<StageViewDeps, "store">>, concept?: Concept): HTMLElement {
  const known = concept && deps.store ? deps.store.isKnown(concept.id) : false;
  const body = h("div", { class: "explain-body" });
  const controls = h("div", { class: "depth" });
  const box = h("div", { class: "explain" + (known ? " known" : "") }, h("h3", {}, block.title, known ? h("span", { class: "pill skipped_known" }, "você já domina") : null), body, controls);
  const levels: [Depth, string | undefined][] = [["quick", block.quick], ["normal", block.normal], ["deep", block.deep]];
  const available = levels.filter(([, text]) => text !== undefined).map(([depth]) => depth);

  const show = (depth: Depth): void => {
    const upTo = levels.findIndex(([d]) => d === depth);
    body.innerHTML = levels.slice(0, upTo + 1).flatMap(([, text]) => (text ? [md(text)] : [])).join("");
    const next = available.find((d) => levels.findIndex(([x]) => x === d) > upTo);
    controls.replaceChildren(
      ...(next === "normal" ? [depthButton("normal", "Explique melhor", show)] : []),
      ...(next === "deep" || (next === "normal" && block.deep) ? [depthButton("deep", "Aprofundar", show)] : []),
      ...(depth !== "quick" ? [depthButton("quick", "Resumir", show)] : []),
    );
    if (depth !== "quick") api.event(deps.stage.id, "explanation_depth", { block: block.id, depth }).catch(reportSyncFailure);
  };
  // Always the minimum first; nothing starts at Deep.
  show("quick");
  return box;
}

function depthButton(depth: Depth, label: string, show: (d: Depth) => void): HTMLButtonElement {
  return h("button", { type: "button", class: "link", "data-depth": depth, onclick: () => show(depth) }, label);
}

function originalRefs(stage: StageDetail): HTMLElement {
  const replayFiles = new Map(stage.referenceCode.map((f) => [f.path, f.content]));
  return h(
    "div",
    { class: "refs" },
    h("p", { class: "muted" }, "Mesma ideia, versão de produção. Abra para comparar lado a lado."),
    ...stage.originalCodeRefs.map((ref) => originalRef(ref, replayFiles.get(ref.replayFile) ?? "")),
  );
}

function originalRef(ref: OriginalCodeReference, replaySource: string): HTMLElement {
  const replay = replayExcerpt(replaySource, ref.replaySymbol ?? ref.symbol);
  const details = h(
    "details",
    { class: "ref" },
    h("summary", {}, h("code", {}, ref.symbol), h("span", { class: "muted path" }, `${ref.path}:${ref.startLine}-${ref.endLine}`)),
  );
  details.addEventListener("toggle", () => {
    if (!details.open || details.querySelector(".compare")) return;
    details.append(
      h("p", { class: "note" }, ref.note),
      h(
        "div",
        { class: "compare" },
        h("div", {}, h("p", { class: "eyebrow" }, `Replay · ${ref.replayFile}`), replay ? codeView(ref.replayFile, replay.text, { firstLine: replay.firstLine }) : h("p", { class: "muted pad" }, "—")),
        h("div", {}, h("p", { class: "eyebrow" }, "Produção ", h("a", { href: ref.url, target: "_blank", rel: "noopener noreferrer" }, "GitHub ↗")), codeView(ref.path, ref.snippet, { firstLine: ref.startLine })),
      ),
    );
  });
  return details;
}

/** The replay declaration matching a production symbol (names may differ by prefix, e.g. CATEGORY_SIGNALS ↔ SIGNALS). */
function replayExcerpt(source: string, symbol: string): { text: string; firstLine: number } | undefined {
  const lines = source.split("\n");
  const candidates = [symbol, symbol.replace(/^[A-Z]+_/, "")];
  const start = lines.findIndex((line) => candidates.some((name) => new RegExp(`\\b(function|const|class|interface|enum|type)\\s+${name}\\b`).test(line)));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^(\}|\];|\};)/.test(line));
  const stop = end < 0 ? Math.min(lines.length, start + 30) : end + 1;
  return { text: lines.slice(start, stop).join("\n"), firstLine: start + 1 };
}

type ExerciseView = {
  element: HTMLElement;
  /** Where stage-specific controls (show solution, compare) are appended. */
  toolbar: HTMLElement;
  run(): void;
  focus(): void;
  values(): CodeFile[];
  selection(): TutorSelection | undefined;
};

function buildExercise(
  { stage, store }: StageViewDeps,
  options: { onPass?: () => void; allowSolution?: boolean; start?: StartingPoint | undefined } = {},
): ExerciseView | undefined {
  const exercise = stage.exercise;
  if (!exercise) return undefined;
  const saved = drafts(stage.id);
  const start = options.start?.files ?? exercise.starterFiles;
  const startOf = (path: string): string => start.find((f) => f.path === path)?.content ?? "";
  const artifacts = h("p", { class: "notice small", hidden: true });
  const editors = new Map<string, Editor>();
  for (const file of exercise.starterFiles) {
    const editor = createEditor(file.path, saved.load(file.path) ?? startOf(file.path), {
      onChange: (src) => {
        saved.save(file.path, src);
        showArtifacts(src);
      },
    });
    editors.set(file.path, editor);
  }
  // Text copied from rendered pages (chat, docs) can carry markdown/HTML artifacts; offer an explicit cleanup.
  const showArtifacts = (src: string): void => {
    const found = pasteArtifacts(src);
    artifacts.hidden = found === 0;
    if (found === 0) return;
    artifacts.replaceChildren(
      `Parece que o texto colado trouxe artefatos de formatação (${found}: &#x20;, \\ no fim da linha, entidades HTML). `,
      h("button", {
        type: "button",
        class: "link",
        onclick: () => {
          for (const [, editor] of editors) editor.setValue(cleanArtifacts(editor.value()));
        },
      }, "Limpar"),
    );
  };
  let active = exercise.starterFiles[0]?.path ?? "";
  let running = false;

  const results = h("div", { class: "results", "aria-live": "polite" });
  const runButton = h("button", { type: "button", class: "btn primary", onclick: () => run() }, "▶ Rodar testes", h("kbd", {}, "Ctrl/⌘ ↵"));
  const tabs: Tab[] = [
    ...exercise.starterFiles.map((file) => ({
      label: file.path,
      render: () => {
        active = file.path;
        return editors.get(file.path)?.element ?? h("div");
      },
    })),
    { label: "o que os testes verificam", extraClass: "secondary", render: () => codeView(exercise.testFile.path, exercise.testFile.content) },
    ...(exercise.typecheck?.files ?? []).map((file) => ({ label: "verificação de tipos", extraClass: "secondary", render: () => codeView(file.path, file.content) })),
  ];
  const values = (): CodeFile[] => exercise.starterFiles.map((f) => ({ path: f.path, content: editors.get(f.path)?.value() ?? f.content }));

  const toolbar = h("div", { class: "row run-row" },
    runButton,
    h("button", {
      type: "button",
      class: "link",
      onclick: () => {
        for (const file of exercise.starterFiles) {
          editors.get(file.path)?.setValue(startOf(file.path));
          saved.clear(file.path);
        }
        results.replaceChildren();
      },
    }, options.start ? "Voltar ao ponto de partida" : "Recomeçar"),
  );
  const referenceFallback = options.start?.referenceFiles;
  if (referenceFallback) {
    toolbar.append(h("button", {
      type: "button",
      class: "link",
      title: "Substitui o seu código pela solução de referência da etapa anterior",
      onclick: () => referenceFallback.forEach((f) => editors.get(f.path)?.setValue(f.content)),
    }, "Usar a referência da etapa anterior"));
  }
  const solutionView = h("div", { class: "solution", hidden: true },
    h("p", { class: "eyebrow" }, "Solução de referência"),
    ...exercise.solutionFiles.map((f) => codeView(f.path, f.content)),
  );
  if (options.allowSolution) {
    toolbar.append(h("button", {
      type: "button",
      class: "link",
      onclick: () => {
        solutionView.hidden = !solutionView.hidden;
        if (!solutionView.hidden) api.event(stage.id, "solution_revealed").catch(reportSyncFailure);
      },
    }, "Ver solução"));
  }
  const origin = options.start?.origin ?? (exercise.starterFiles.every((f) => f.content === "") ? "empty" : "reference");
  const originNote: Record<typeof origin, string> = {
    empty: "Editor vazio de propósito: escreva do zero. Esqueceu uma ferramenta da linguagem? Consulte a Toolbox.",
    own: "Este é o seu código da etapa anterior. Faça só a mudança pedida.",
    reference: "Você não tem uma versão aceita da etapa anterior (pulou?), então começamos da solução de referência dela. A partir daqui o código é seu.",
  };

  const element = h(
    "div",
    { class: "exercise" },
    h("div", { class: "instructions", html: md(exercise.instructions) }),
    h("p", { class: `muted origin ${origin}` }, originNote[origin]),
    artifacts,
    fileTabs(tabs),
    toolbar,
    results,
    options.allowSolution ? solutionView : null,
  );

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    runButton.disabled = true;
    results.replaceChildren(h("p", { class: "muted" }, "Rodando…"));
    try {
      const outcome = await runExercise(stage.id, values());
      const passed = outcome.result.tests.length > 0 && outcome.result.tests.every((t) => t.passed);
      results.replaceChildren(renderResult(outcome.result, outcome.firstPass));
      if (store.status(stage.id) === "not_started") store.setStatus(stage.id, "in_progress");
      if (passed) {
        // The learner's passing code becomes the state the next step starts from.
        acceptedCode(stage.id).save(values());
        options.onPass?.();
      }
    } catch (error) {
      results.replaceChildren(h("p", { class: "fail" }, error instanceof Error ? error.message : "Falha ao rodar os testes."));
    } finally {
      running = false;
      runButton.disabled = false;
    }
  }

  return {
    element,
    toolbar,
    run: () => void run(),
    focus: () => editors.get(active)?.focus(),
    values,
    selection: () => editors.get(active)?.selection(),
  };
}

function renderResult(result: RunResult, firstPass: boolean): HTMLElement {
  const passed = result.tests.filter((t) => t.passed).length;
  const all = passed === result.tests.length && result.tests.length > 0;
  return h(
    "div",
    { class: "result" + (all ? " pass" : " fail") },
    h("p", { class: "result-head" },
      all ? `✓ ${passed}/${result.tests.length} testes passaram` : `${passed}/${result.tests.length} testes passaram`,
      h("span", { class: "muted" }, ` · ${result.latencyMs} ms`),
      all && firstPass ? h("span", { class: "pill completed" }, "de primeira") : null,
    ),
    h("ul", { class: "tests" }, ...result.tests.map((t) => h("li", { class: t.passed ? "ok" : "ko" }, h("span", { class: "mark", "aria-hidden": "true" }, t.passed ? "✓" : "✗"), h("span", {}, t.name, t.error ? h("code", { class: "err" }, t.error) : null)))),
    result.stdout ? h("pre", { class: "stdout" }, result.stdout) : null,
    result.stderr && !all ? h("details", { class: "diagnostic" }, h("summary", {}, "Diagnóstico"), h("pre", { class: "stdout" }, result.stderr)) : null,
  );
}

function checkpoint(stage: StageDetail): HTMLElement {
  const check = stage.checkpoint;
  if (!check) return h("div");
  const answer = h("div", { class: "answer", hidden: true }, h("p", {}, check.answer));
  return h(
    "div",
    { class: "checkpoint-q" },
    h("p", {}, check.question),
    h("button", {
      type: "button",
      class: "link",
      onclick: (event) => {
        answer.hidden = false;
        (event.currentTarget as HTMLElement).remove();
        api.event(stage.id, "checkpoint_revealed").catch(reportSyncFailure);
      },
    }, "Revelar resposta"),
    answer,
  );
}

function actionBar({ journey, stage, actions }: StageViewDeps, completeLabel?: string): HTMLElement {
  const isLast = stage.order === journey.stages.length;
  return h(
    "footer",
    { class: "actions" },
    h("button", { type: "button", class: "btn primary", onclick: actions.complete }, completeLabel ?? (isLast ? "✓ Entendi — concluir jornada" : "✓ Entendi — próxima")),
    h("button", { type: "button", class: "btn", onclick: actions.skipKnown }, "→ Já domino — pular"),
    h("button", { type: "button", class: "link", onclick: actions.skip, title: "Avançar sem marcar como dominada" }, "pular por agora"),
    h("span", { class: "spacer" }),
    h("span", { class: "muted keys" }, h("kbd", {}, "Alt ←"), " ", h("kbd", {}, "Alt →")),
  );
}

/** Remembers the last section in view, for instant resume. */
function trackAnchors(root: HTMLElement, stageId: string, store: ProgressStore): void {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.find((e) => e.isIntersecting);
      const anchor = visible?.target.getAttribute("data-anchor");
      if (anchor) store.setAnchor(stageId, anchor);
    },
    { rootMargin: "-20% 0px -60% 0px" },
  );
  queueMicrotask(() => root.querySelectorAll("[data-anchor]").forEach((el) => observer.observe(el)));
}

const SELECTION_SETTLE_MS = 150;

/** Select code anywhere in the stage → a floating "Explain" sends it to the tutor. */
function attachExplainButton(root: HTMLElement, actions: StageActions, editorSelection: () => TutorSelection | undefined): void {
  const button = h("button", { type: "button", class: "explain-btn", hidden: true }, "Explain");
  let pending: TutorSelection | undefined;
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    if (pending) actions.explain(pending);
    button.hidden = true;
  });
  root.append(button);

  const update = (): void => {
    const active = document.activeElement;
    const fromEditor = active instanceof HTMLTextAreaElement && root.contains(active) ? editorSelection() : undefined;
    pending = fromEditor ?? selectionFromCodeView();
    if (!pending) {
      button.hidden = true;
      return;
    }
    const rect = fromEditor ? active?.getBoundingClientRect() : window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    if (!rect) return;
    const host = root.getBoundingClientRect();
    button.style.top = `${rect.top - host.top - 34}px`;
    button.style.left = `${Math.max(0, (fromEditor ? rect.right - 90 : rect.left) - host.left)}px`;
    button.hidden = false;
  };
  // selectionchange covers mouse, keyboard and touch selections alike.
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const onSelectionChange = (): void => {
    if (!root.isConnected) {
      document.removeEventListener("selectionchange", onSelectionChange);
      return;
    }
    clearTimeout(scheduled);
    scheduled = setTimeout(update, SELECTION_SETTLE_MS);
  };
  document.addEventListener("selectionchange", onSelectionChange);
}

const list = (items: string[]): string =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} e ${items.at(-1) ?? ""}`;

const ARTIFACTS = /&#x?[0-9a-f]+;|&(?:nbsp|lt|gt|amp|quot);|\\[ \t]*$/gim;

function pasteArtifacts(source: string): number {
  return source.match(ARTIFACTS)?.length ?? 0;
}

function cleanArtifacts(source: string): string {
  const entities: Record<string, string> = { "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"' };
  return source
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(?:nbsp|lt|gt|amp|quot);/gi, (m) => entities[m.toLowerCase()] ?? m)
    .replace(/[ \t]*\\[ \t]*$/gm, "");
}
