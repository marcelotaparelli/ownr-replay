import type { JourneyOutline } from "../src/domain/journey.ts";
import { api, type JourneyCard, type StageDetail } from "./api.ts";
import { selectionFromCodeView } from "./code-view.ts";
import { $, h } from "./dom.ts";
import { renderHome, renderKnowledgeMap, renderNav, renderOverview, stageHref } from "./journey-view.ts";
import { renderStage, type MountedStage } from "./stage-view.ts";
import { ProgressStore, flushOutbox, reportSyncFailure } from "./store.ts";
import { renderToolbox } from "./toolbox.ts";
import { mountTutor } from "./tutor.ts";

const nav = $("#journey");
const main = $("#main");
const crumb = $("#crumb");
const toolboxRoot = $("#toolbox");
const tutor = mountTutor($("#tutor"));

type Current = { journey: JourneyOutline; stage: StageDetail; mounted: MountedStage; store: ProgressStore; watch: Stopwatch };
let current: Current | undefined;
let journeyList: Promise<JourneyCard[]> | undefined;

const outlines = new Map<string, Promise<JourneyOutline>>();
const stages = new Map<string, Promise<StageDetail>>();
const stores = new Map<string, ProgressStore>();

function loadJourney(id: string): Promise<JourneyOutline> {
  let pending = outlines.get(id);
  if (!pending) {
    pending = api.journey(id);
    outlines.set(id, pending);
    pending.catch(() => outlines.delete(id));
    // Server progress may be ahead of this device (another browser); merge once per session.
    api
      .progress(id)
      .then((server) => {
        storeFor(id).merge(server);
        if (current?.journey.id === id) renderNav(nav, current.journey, current.store, current.stage.id);
      })
      .catch(reportSyncFailure);
  }
  return pending;
}

function loadStage(id: string): Promise<StageDetail> {
  let pending = stages.get(id);
  if (!pending) {
    pending = api.stage(id);
    stages.set(id, pending);
    pending.catch(() => stages.delete(id));
  }
  return pending;
}

function storeFor(journeyId: string): ProgressStore {
  let store = stores.get(journeyId);
  if (!store) {
    store = new ProgressStore(journeyId);
    stores.set(journeyId, store);
  }
  return store;
}

async function route(): Promise<void> {
  leaveStage();
  // The previous view stays visible while the next loads, but must not be actionable:
  // a quick second click would otherwise act on a stage the learner already left.
  main.inert = true;
  main.setAttribute("aria-busy", "true");
  try {
    await render();
  } finally {
    main.inert = false;
    main.removeAttribute("aria-busy");
  }
}

async function render(): Promise<void> {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  try {
    if (parts[0] !== "j" || !parts[1]) return await showHome();
    const journey = await loadJourney(parts[1]);
    const store = storeFor(journey.id);
    if (parts[2] === "s" && parts[3]) return await showStage(journey, store, Number(parts[3]));
    idleSidebar();
    renderNav(nav, journey, store, undefined);
    if (parts[2] === "mapa") {
      const draw = (): void => {
        main.replaceChildren(renderKnowledgeMap(journey, store, draw));
        renderNav(nav, journey, store, undefined);
      };
      setCrumb(journey, "Mapa de conhecimento");
      draw();
    } else {
      setCrumb(journey);
      main.replaceChildren(renderOverview(journey, store));
    }
    main.scrollTop = 0;
  } catch (error) {
    main.replaceChildren(h("article", { class: "overview" }, h("h1", {}, "Não encontrado"), h("p", {}, error instanceof Error ? error.message : "Falha ao carregar."), h("a", { href: "#/" }, "Voltar ao início")));
  }
}

async function showHome(): Promise<void> {
  journeyList ??= api.journeys();
  const journeys = await journeyList;
  // A single curated journey: go straight to it.
  const only = journeys[0];
  if (journeys.length === 1 && only) {
    location.replace(`#/j/${only.id}`);
    return;
  }
  idleSidebar();
  nav.replaceChildren();
  crumb.textContent = "";
  main.replaceChildren(renderHome(journeys));
}

async function showStage(journey: JourneyOutline, store: ProgressStore, order: number): Promise<void> {
  const outline = journey.stages.find((s) => s.order === order);
  if (!outline) throw new Error(`Stage ${order} não existe nesta jornada.`);
  const previousOutline = journey.stages.find((s) => s.order === order - 1);
  const [stage, previous] = await Promise.all([loadStage(outline.id), previousOutline ? loadStage(previousOutline.id) : undefined]);
  if (location.hash !== stageHref(journey.id, order)) return; // navigated away while loading

  store.setLast(stage.id);
  if (store.status(stage.id) === "not_started") store.setStatus(stage.id, "in_progress");
  api.event(stage.id, "stage_opened").catch(reportSyncFailure);

  const module = journey.modules.find((m) => m.id === stage.moduleId);
  if (!module) throw new Error(`Módulo ${stage.moduleId} não existe nesta jornada.`);
  const moduleStages = journey.stages.filter((s) => s.moduleId === module.id);
  const mounted = renderStage({ journey, stage, previous, module, moduleStages, store, actions: stageActions(journey, store, stage) });
  current = { journey, stage, mounted, store, watch: stopwatch() };

  main.replaceChildren(mounted.element);
  restoreAnchor(store.snapshot.stages[stage.id]?.anchor, store.status(stage.id));
  setCrumb(journey, `${module.title} · ${stage.title}`);
  renderNav(nav, journey, store, stage.id);
  tutor.setStage(stage, suggestionsFor(journey, stage));
  renderToolbox(toolboxRoot, stage.toolbox, (question) => tutor.ask(question));
  document.title = `${stage.title} · Repo Replay`;

  // Next stage is one click away: fetch it now so navigation feels instant.
  const next = journey.stages.find((s) => s.order === order + 1);
  if (next) loadStage(next.id).catch(reportSyncFailure);
}

function stageActions(journey: JourneyOutline, store: ProgressStore, stage: StageDetail) {
  const advance = (): void => {
    const next = journey.stages.find((s) => s.order === stage.order + 1);
    location.hash = next ? stageHref(journey.id, next.order) : `#/j/${journey.id}`;
  };
  const elapsed = (): number => Math.round(current?.watch.elapsed() ?? 0);
  const isCurrent = (): boolean => current?.stage.id === stage.id;
  return {
    complete: () => {
      if (!isCurrent()) return;
      store.setStatus(stage.id, "completed", { timeSpentMs: elapsed() });
      advance();
    },
    skipKnown: () => {
      if (!isCurrent()) return;
      store.setStatus(stage.id, "skipped_known", { timeSpentMs: elapsed(), knownConcepts: stage.introduces });
      advance();
    },
    skip: () => {
      if (!isCurrent()) return;
      store.setStatus(stage.id, "skipped", { timeSpentMs: elapsed() });
      advance();
    },
    skipModule: () => {
      if (!isCurrent()) return;
      const inModule = journey.stages.filter((s) => s.moduleId === stage.moduleId);
      for (const s of inModule) {
        if (s.kind !== "micro" || ["completed", "skipped_known"].includes(store.status(s.id))) continue;
        store.setStatus(s.id, "skipped_known", { knownConcepts: s.introduces, ...(s.id === stage.id ? { timeSpentMs: elapsed() } : {}) });
      }
      const checkpoint = inModule.find((s) => s.kind === "checkpoint") ?? journey.stages.find((s) => s.order === (inModule.at(-1)?.order ?? 0) + 1);
      location.hash = checkpoint ? stageHref(journey.id, checkpoint.order) : `#/j/${journey.id}`;
    },
    goto: (order: number) => {
      location.hash = stageHref(journey.id, order);
    },
    explain: (selection: Parameters<typeof tutor.ask>[1]) => tutor.ask("Explique este trecho.", selection),
  };
}

function suggestionsFor(journey: JourneyOutline, stage: StageDetail): string[] {
  const concept = journey.concepts.find((c) => c.id === stage.introduces[0]);
  const why = concept ? [`O que acontece sem ${concept.name}?`] : [];
  if (stage.kind === "micro") return ["O que cada linha faz?", "Qual é a limitação desta versão?"];
  return ["Onde isso está no projeto real?", ...why];
}

function leaveStage(): void {
  if (!current) return;
  if (current.store.status(current.stage.id) === "in_progress") current.store.leave(current.stage.id, current.watch.elapsed());
  current.watch.stop();
  current = undefined;
}

function restoreAnchor(anchor: string | undefined, status: string): void {
  const target = status === "in_progress" && anchor ? main.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`) : null;
  if (target) target.scrollIntoView({ block: "start" });
  else main.scrollTop = 0;
}

function idleSidebar(): void {
  tutor.idle();
  toolboxRoot.replaceChildren(h("div", { class: "panel-head" }, h("h2", {}, "Toolbox")), h("p", { class: "muted pad" }, "Ferramentas úteis aparecem aqui quando você abre uma etapa."));
}

function setCrumb(journey: JourneyOutline, tail?: string): void {
  crumb.replaceChildren(h("a", { href: `#/j/${journey.id}` }, journey.title), tail ? ` / ${tail}` : "");
  document.title = tail ? `${tail} · Repo Replay` : `${journey.title} · Repo Replay`;
}

type Stopwatch = { elapsed(): number; stop(): void };

/** Time actually spent looking at the stage: pauses while the tab is hidden. */
function stopwatch(): Stopwatch {
  let total = 0;
  let since: number | undefined = document.hidden ? undefined : performance.now();
  const onVisibility = (): void => {
    if (document.hidden && since !== undefined) {
      total += performance.now() - since;
      since = undefined;
    } else if (!document.hidden && since === undefined) {
      since = performance.now();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  return {
    elapsed: () => total + (since === undefined ? 0 : performance.now() - since),
    stop: () => document.removeEventListener("visibilitychange", onVisibility),
  };
}

document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key === "Enter" && current) {
    event.preventDefault();
    current.mounted.run();
  } else if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    const selection = current?.mounted.editorSelection() ?? selectionFromCodeView();
    if (selection) tutor.attach(selection);
    else tutor.focus();
  } else if (event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft") && current) {
    // Option+arrows move by word in text fields on macOS; leave them alone there.
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    const order = current.stage.order + (event.key === "ArrowRight" ? 1 : -1);
    if (current.journey.stages.some((s) => s.order === order)) location.hash = stageHref(current.journey.id, order);
  }
});

window.addEventListener("hashchange", () => void route());
window.addEventListener("online", () => void flushOutbox());
window.addEventListener("pagehide", leaveStage);
void flushOutbox();
void route();
