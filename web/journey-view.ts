import type { JourneyOutline, StageOutline } from "../src/domain/journey.ts";
import type { KnowledgeLevel, StageStatus } from "../src/domain/progress.ts";
import type { Concept, Module } from "../src/domain/stage.ts";
import { ApiError, api, type JourneyCard } from "./api.ts";
import { h } from "./dom.ts";
import { mdInline } from "./md.ts";
import type { ProgressStore } from "./store.ts";

const STATUS_ICON: Record<StageStatus, string> = {
  not_started: "○",
  in_progress: "→",
  completed: "✓",
  skipped_known: "↷",
  skipped: "·",
};

const STATUS_LABEL: Record<StageStatus, string> = {
  not_started: "não iniciada",
  in_progress: "em andamento",
  completed: "concluída",
  skipped_known: "já dominada",
  skipped: "pulada",
};

export const stageHref = (journeyId: string, order: number): string => `#/j/${journeyId}/s/${order}`;

const DONE: readonly StageStatus[] = ["completed", "skipped_known"];

export function renderNav(root: HTMLElement, journey: JourneyOutline, store: ProgressStore, currentStageId: string | undefined): void {
  const done = journey.stages.filter((s) => DONE.includes(store.status(s.id))).length;
  const current = journey.stages.find((s) => s.id === currentStageId);
  // With no stage open, expand the module where the learner should continue.
  const focusModule = current?.moduleId ?? journey.stages.find((s) => !DONE.includes(store.status(s.id)))?.moduleId;
  root.replaceChildren(
    h("div", { class: "panel-head" }, h("h2", {}, h("a", { href: `#/j/${journey.id}` }, "Journey")), h("span", { class: "muted" }, `${done}/${journey.stages.length}`)),
    meter(done, journey.stages.length),
    h("ol", { class: "module-list" }, ...journey.modules.map((module, index) => moduleItem(journey, module, index, store, currentStageId, module.id === focusModule))),
    h("a", { class: "nav-link", href: `#/j/${journey.id}/mapa` }, "Mapa de conhecimento"),
  );
}

function moduleItem(journey: JourneyOutline, module: Module, index: number, store: ProgressStore, currentStageId: string | undefined, open: boolean): HTMLElement {
  const stages = journey.stages.filter((s) => s.moduleId === module.id);
  const done = stages.filter((s) => DONE.includes(store.status(s.id))).length;
  const complete = done === stages.length;
  const first = stages.find((s) => !DONE.includes(store.status(s.id))) ?? stages[0];
  const head = h(
    "a",
    { class: "module-head" + (open ? " open" : ""), href: first ? stageHref(journey.id, first.order) : "#" },
    h("span", { class: "icon" + (complete ? " done" : "") }, complete ? "✓" : String(index + 1)),
    h("span", { class: "t" }, module.title),
    stages.length > 1 ? h("span", { class: "count" }, `${done}/${stages.length}`) : null,
  );
  if (!open || stages.length === 1) return h("li", { class: "module" }, head);
  return h(
    "li",
    { class: "module" },
    head,
    h(
      "ol",
      { class: "stage-list" },
      ...stages.map((stage) => {
        const status = store.status(stage.id);
        return h(
          "li",
          { class: status },
          h(
            "a",
            { href: stageHref(journey.id, stage.order), "aria-current": stage.id === currentStageId ? "page" : undefined, title: STATUS_LABEL[status] },
            h("span", { class: "icon", "aria-label": STATUS_LABEL[status] }, stage.kind === "checkpoint" && !DONE.includes(status) ? "◆" : STATUS_ICON[status]),
            h("span", { class: "t" }, stage.title),
          ),
        );
      }),
    ),
  );
}

/** Width is set through CSSOM: the CSP forbids inline style attributes. */
function meter(done: number, total: number): HTMLElement {
  const fill = h("span");
  fill.style.width = `${total === 0 ? 0 : (done / total) * 100}%`;
  return h("div", { class: "meter", role: "progressbar", "aria-label": "Progresso da jornada", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": done }, fill);
}

/** Journey landing: what this is, and where you left off. */
export function renderOverview(journey: JourneyOutline, store: ProgressStore): HTMLElement {
  const last = journey.stages.find((s) => s.id === store.snapshot.lastStageId);
  const next = journey.stages.find((s) => !["completed", "skipped_known"].includes(store.status(s.id)));
  const anchor = last ? store.snapshot.stages[last.id]?.anchor : undefined;
  const target = last && !["completed", "skipped_known"].includes(store.status(last.id)) ? last : next;

  return h(
    "article",
    { class: "overview" },
    h("p", { class: "eyebrow" }, "Repo Replay"),
    h("h1", {}, journey.title),
    h("p", { class: "subtitle" }, journey.description),
    h("p", { class: "muted" },
      h("a", { href: `${journey.repo.url}/tree/${journey.repo.sha}`, target: "_blank", rel: "noopener noreferrer" }, `${journey.repo.owner}/${journey.repo.name}@${journey.repo.sha.slice(0, 7)} ↗`),
      ` · ${journey.stages.length} etapas · ~${journey.stages.reduce((n, s) => n + s.estimatedMinutes, 0)} min`,
    ),
    target
      ? h(
          "aside",
          { class: "resume" },
          last && target.id === last.id
            ? [
                h("p", {}, "Você estava em ", h("strong", {}, `${moduleTitle(journey, last)} — ${last.title}`), "."),
                anchor ? h("p", { class: "muted" }, `Último ponto: ${anchor}.`) : null,
              ]
            : h("p", {}, next?.order === 1 ? "Comece pelo menor programa possível. Cada etapa acrescenta uma única ideia." : h("span", {}, "Próxima: ", h("strong", {}, `${moduleTitle(journey, target)} — ${target.title}`))),
          h("a", { class: "btn primary", href: stageHref(journey.id, target.order) }, last && target.id === last.id ? "Continuar" : next?.order === 1 ? "Começar" : "Continuar"),
        )
      : h("aside", { class: "resume done" }, h("p", {}, "Jornada concluída. Abra o repositório real e confira se ele agora parece familiar.")),
    h("h2", {}, "Evolução"),
    h("ol", { class: "evolution" }, ...journey.modules.map((m) => evolutionItem(journey, m, store))),
  );
}

function evolutionItem(journey: JourneyOutline, module: Module, store: ProgressStore): HTMLElement {
  const stages = journey.stages.filter((s) => s.moduleId === module.id);
  const done = stages.filter((s) => DONE.includes(store.status(s.id))).length;
  const first = stages.find((s) => !DONE.includes(store.status(s.id))) ?? stages[0];
  const minutes = stages.reduce((n, s) => n + s.estimatedMinutes, 0);
  return h(
    "li",
    { class: done === stages.length ? "completed" : done > 0 ? "in_progress" : "not_started" },
    h("a", { href: first ? stageHref(journey.id, first.order) : "#" }, h("strong", {}, module.title)),
    h("span", { class: "muted" }, ` — ${module.subtitle ?? ""} · ${stages.length > 1 ? `${stages.length} etapas, ` : ""}~${minutes} min${done ? ` · ${done}/${stages.length}` : ""}`),
  );
}

function moduleTitle(journey: JourneyOutline, stage: StageOutline): string {
  return journey.modules.find((m) => m.id === stage.moduleId)?.title ?? "";
}

type ConceptRow = { concept: Concept; state: KnowledgeLevel; stage: StageOutline | undefined };

/** Where ownership gaps remain. Deliberately a list, not a dashboard. */
export function renderKnowledgeMap(journey: JourneyOutline, store: ProgressStore, rerender: () => void): HTMLElement {
  const rows: ConceptRow[] = journey.concepts.map((concept) => {
    const stage = journey.stages.find((s) => s.introduces.includes(concept.id));
    return { concept, stage, state: conceptState(concept.id, stage, store) };
  });
  const groups = [...new Set(journey.concepts.map((c) => c.group))];
  const known = rows.filter((r) => r.state === "known" || r.state === "mastered").length;

  return h(
    "article",
    { class: "knowledge" },
    h("p", { class: "eyebrow" }, `${journey.title} · o que este projeto usa`),
    h("h1", {}, "Mapa de conhecimento"),
    h("p", { class: "subtitle" }, `${known} de ${rows.length} conceitos sob seu domínio. Marque o que você já sabe: explicações futuras ficam mais curtas.`),
    ...groups.map((group) =>
      h(
        "section",
        { class: "kgroup" },
        h("h2", {}, group),
        h(
          "ul",
          {},
          ...rows
            .filter((r) => r.concept.group === group)
            .map(({ concept, state, stage }) =>
              h(
                "li",
                { class: state },
                h("span", { class: "icon", "aria-label": state }, state === "known" || state === "mastered" ? "✓" : state === "learning" ? "→" : "○"),
                h("span", { class: "kname" }, concept.name),
                h("span", { class: "muted kquick", html: mdInline(concept.quick) }),
                stage ? h("a", { class: "muted", href: stageHref(journey.id, stage.order) }, stage.title) : null,
                state === "known" && !store.isKnown(concept.id) ? h("span") : h("button", {
                  type: "button",
                  class: "link",
                  "aria-pressed": String(store.isKnown(concept.id)),
                  onclick: () => {
                    store.toggleKnown(concept.id);
                    rerender();
                  },
                }, store.isKnown(concept.id) ? "desmarcar" : "já sei"),
              ),
            ),
        ),
      ),
    ),
  );
}

/** Explicit declarations win; otherwise ownership follows the stage that introduced the concept. */
export function conceptState(conceptId: string, stage: StageOutline | undefined, store: ProgressStore): KnowledgeLevel {
  if (store.isKnown(conceptId)) return "known";
  const status = stage ? store.status(stage.id) : "not_started";
  if (status === "completed" || status === "skipped_known") return "known";
  if (status === "in_progress") return "learning";
  return "unknown";
}

export function renderHome(journeys: JourneyCard[]): HTMLElement {
  const message = h("p", { class: "muted", "aria-live": "polite" });
  const input = h("input", { type: "url", name: "repoUrl", required: true, placeholder: "https://github.com/owner/repo", "aria-label": "URL do repositório no GitHub" });
  const form = h("form", { class: "repo-form" }, input, h("button", { class: "btn primary", type: "submit" }, "Gerar jornada"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    message.textContent = "Verificando…";
    api
      .createJourney(input.value)
      .then(({ id }) => {
        location.hash = `#/j/${id}`;
      })
      .catch((error: unknown) => {
        message.textContent = error instanceof ApiError ? error.message : "Falha ao criar a jornada.";
      });
  });
  return h(
    "article",
    { class: "home" },
    h("h1", {}, "Repo Replay"),
    h("p", { class: "subtitle" }, "Entenda um repositório real reconstruindo sua arquitetura em poucas etapas incrementais."),
    form,
    message,
    h("h2", {}, "Jornadas disponíveis"),
    h(
      "ul",
      { class: "journeys" },
      ...journeys.map((j) =>
        h("li", {}, h("a", { href: `#/j/${j.id}` }, h("strong", {}, j.title)), h("span", { class: "muted" }, ` · ${j.stageCount} etapas`), h("p", {}, j.description)),
      ),
    ),
  );
}

