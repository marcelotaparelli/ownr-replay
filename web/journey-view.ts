import type { JourneyOutline, StageOutline } from "../src/domain/journey.ts";
import { planJourney, type Confidence, type JourneyPlan } from "../src/domain/pace.ts";
import type { KnowledgeLevel, StageStatus } from "../src/domain/progress.ts";
import type { Concept, Module } from "../src/domain/stage.ts";
import { ApiError, api, type JourneyCard } from "./api.ts";
import type { LearningGoal, LearningGoalKind, LearningTopic } from "../src/domain/learning-goal.ts";
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
function meter(done: number, total: number, label = "Progresso da jornada"): HTMLElement {
  const fill = h("span");
  fill.style.width = `${total === 0 ? 0 : (done / total) * 100}%`;
  return h("div", { class: "meter", role: "progressbar", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": done }, fill);
}

const CONFIDENCE: Record<Confidence, { dots: string; label: string }> = {
  none: { dots: "○○○", label: "sem dados do seu ritmo — usando a estimativa do autor" },
  low: { dots: "●○○", label: "baixa" },
  medium: { dots: "●●○", label: "média" },
  high: { dots: "●●●", label: "alta" },
};

const duration = (minutes: number): string => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`);

/** Where am I, how much is left, how long at my pace — for the mapped route only. */
function renderPlan(plan: JourneyPlan): HTMLElement {
  const { pace, eta } = plan;
  const confidence = CONFIDENCE[eta.confidence];
  const paceText =
    pace.samples === 0
      ? "Seu ritmo: ainda sem etapas resolvidas com tempo medível."
      : `Seu ritmo: ~${pace.medianMinutes} min por micro etapa (mediana de ${pace.samples}) · ${pace.factor}× a estimativa do autor.`;
  const excluded = [
    pace.skippedKnown ? `${pace.skippedKnown} marcada(s) como já dominadas` : null,
    pace.tooFast ? `${pace.tooFast} concluída(s) em menos de 15 s` : null,
  ].filter(Boolean);
  return h(
    "section",
    { class: "plan", "aria-label": "Plano de aprendizado" },
    h(
      "p",
      { class: "plan-head" },
      h("strong", {}, `${plan.percent}%`),
      " do percurso mapeado",
      h("span", { class: "muted" }, ` · micro etapas ${plan.micro.done}/${plan.micro.total} · checkpoint${plan.checkpoints.total === 1 ? "" : "s"} ${plan.checkpoints.done}/${plan.checkpoints.total}`),
    ),
    meter(plan.percent, 100, "Progresso do percurso mapeado"),
    h(
      "p",
      {},
      eta.remainingStages === 0 ? "Percurso mapeado concluído." : [`Falta ~${duration(eta.minutes)}`, h("span", { class: "muted" }, ` (entre ${duration(eta.low)} e ${duration(eta.high)}) no seu ritmo`)],
      " · confiança ",
      h("span", { class: `confidence c-${eta.confidence}`, title: confidence.label }, confidence.dots),
      ` ${confidence.label}`,
    ),
    h("p", { class: "muted" }, paceText, excluded.length ? ` Fora do ritmo (contam no progresso): ${excluded.join(", ")}.` : ""),
    plan.partial
      ? h(
          "p",
          { class: "muted" },
          `Estimativa parcial: cobre só o percurso já decomposto em micro etapas. ${plan.unmapped.modules} módulo(s) ainda são capítulos (${plan.unmapped.done}/${plan.unmapped.total} vistos) e ficam fora do % e do tempo; o total será refinado conforme a jornada for decomposta.`,
        )
      : null,
  );
}

/** Journey landing: what this is, and where you left off. */
export function renderOverview(journey: JourneyOutline, store: ProgressStore, onGenerate?: (moduleId: string) => Promise<void>): HTMLElement {
  const last = journey.stages.find((s) => s.id === store.snapshot.lastStageId);
  const next = journey.stages.find((s) => !["completed", "skipped_known"].includes(store.status(s.id)));
  const anchor = last ? store.snapshot.stages[last.id]?.anchor : undefined;
  const target = last && !["completed", "skipped_known"].includes(store.status(last.id)) ? last : next;
  const plan = planJourney(journey.stages, (id) => store.progress(id));

  return h(
    "article",
    { class: "overview" },
    h("p", { class: "eyebrow" }, "OWNR"),
    h("h1", {}, journey.title),
    h("p", { class: "subtitle" }, journey.description),
    h("p", { class: "muted" },
      h("a", { href: `${journey.repo.url}/tree/${journey.repo.sha}`, target: "_blank", rel: "noopener noreferrer" }, `${journey.repo.owner}/${journey.repo.name}@${journey.repo.sha.slice(0, 7)} ↗`),
      ` · ${journey.stages.length} etapas`,
    ),
    plan ? renderPlan(plan) : null,
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
    h("ol", { class: "evolution" }, ...journey.modules.map((m) => evolutionItem(journey, m, store, onGenerate))),
  );
}

function evolutionItem(journey: JourneyOutline, module: Module, store: ProgressStore, onGenerate?: (moduleId: string) => Promise<void>): HTMLElement {
  const stages = journey.stages.filter((s) => s.moduleId === module.id);
  const done = stages.filter((s) => DONE.includes(store.status(s.id))).length;
  const first = stages.find((s) => !DONE.includes(store.status(s.id))) ?? stages[0];
  const minutes = stages.reduce((n, s) => n + s.estimatedMinutes, 0);
  const legacy = journey.id === "ops-triage-ai" && module.id === "m2" && stages.length === 1 && stages[0]?.kind === "chapter";
  const message = h("span", { class: "muted", role: "status" });
  const generate = legacy && onGenerate ? h("button", { type: "button", class: "btn", onclick: async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    message.textContent = "Gerando percurso…";
    try { await onGenerate(module.id); } catch (error) {
      message.className = "fail";
      message.textContent = error instanceof Error ? error.message : "Falha ao gerar o percurso.";
      button.disabled = false;
    }
  } }, "Gerar percurso deste módulo") : null;
  return h(
    "li",
    { class: done === stages.length ? "completed" : done > 0 ? "in_progress" : "not_started" },
    h("a", { href: first ? stageHref(journey.id, first.order) : "#" }, h("strong", {}, module.title)),
    h("span", { class: "muted" }, ` — ${module.subtitle ?? ""} · ${stages.length > 1 ? `${stages.length} etapas, ` : ""}~${minutes} min${done ? ` · ${done}/${stages.length}` : ""}`),
    generate,
    legacy ? message : null,
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

type GoalOption = { kind: LearningGoalKind; title: string; hint: string };

const GOALS: GoalOption[] = [
  { kind: "from_scratch", title: "Aprender o projeto do zero", hint: "Do menor programa possível até a arquitetura completa." },
  { kind: "main_flow", title: "Entender o fluxo principal", hint: "Da entrada à resposta, focando em como as partes se ligam." },
  { kind: "trace_request", title: "Rastrear uma requisição", hint: "Uma requisição concreta, do início ao fim." },
  { kind: "specific_part", title: "Entender uma parte específica", hint: "Um arquivo, classe ou função — e só o que ela exige." },
  { kind: "architecture_why", title: "Entender por que a arquitetura é assim", hint: "As forças que criaram cada camada." },
  { kind: "topic", title: "Entender um tema", hint: "Persistência, segurança, testes ou integrações." },
  { kind: "other", title: "Outro objetivo", hint: "Descreva com suas palavras." },
];

const TOPICS: { value: LearningTopic; label: string }[] = [
  { value: "persistence", label: "Persistência / banco" },
  { value: "security", label: "Autenticação / segurança" },
  { value: "tests", label: "Testes" },
  { value: "integrations", label: "Integrações (LLM, HTTP)" },
];

const SAMPLE_REPO = "https://github.com/marcelotaparelli/ops-triage-ai";

/** Repo + what the developer wants to understand → a journey (planned per goal in the future). */
export function renderHome(journeys: JourneyCard[], resume: { journey: JourneyCard; label: string } | undefined): HTMLElement {
  const message = h("div", { class: "goal-message", "aria-live": "polite" });
  const url = h("input", { type: "url", name: "repoUrl", required: true, value: SAMPLE_REPO, placeholder: "https://github.com/owner/repo", "aria-label": "URL do repositório no GitHub" });
  const target = h("input", { type: "text", name: "target", maxlength: 120, placeholder: "ex.: HybridPolicy, src/server.ts", "aria-label": "Qual parte" });
  const topic = h("select", { name: "topic", "aria-label": "Tema" }, ...TOPICS.map((t) => h("option", { value: t.value }, t.label)));
  const note = h("textarea", { name: "note", rows: 2, maxlength: 300, placeholder: "O que você quer entender?", "aria-label": "Objetivo" });
  const extras: Partial<Record<LearningGoalKind, HTMLElement>> = { specific_part: target, trace_request: target, topic, other: note };

  const options = GOALS.map((goal, index) =>
    h(
      "label",
      { class: "goal-option" },
      h("input", { type: "radio", name: "goal", value: goal.kind, checked: index === 0 }),
      h("span", {}, h("strong", {}, goal.title), h("span", { class: "muted" }, goal.hint)),
    ),
  );
  const extraSlot = h("div", { class: "goal-extra" });
  const selected = (): LearningGoalKind => {
    const value = new FormData(form).get("goal");
    return GOALS.find((g) => g.kind === value)?.kind ?? "from_scratch";
  };
  const form = h(
    "form",
    { class: "goal-form" },
    h("label", { class: "field" }, h("span", { class: "eyebrow" }, "Repositório"), url),
    h("fieldset", {}, h("legend", { class: "eyebrow" }, "O que você quer entender?"), ...options),
    extraSlot,
    h("button", { class: "btn primary", type: "submit" }, "Montar jornada →"),
  );
  form.addEventListener("change", () => {
    const extra = extras[selected()];
    extraSlot.replaceChildren(...(extra ? [extra] : []));
    if (selected() === "trace_request") target.placeholder = "ex.: POST /tickets/triage";
    else target.placeholder = "ex.: HybridPolicy, src/server.ts";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const kind = selected();
    const goal: LearningGoal = {
      kind,
      ...(extras[kind] === target && target.value.trim() ? { target: target.value.trim() } : {}),
      ...(kind === "topic" ? { topic: topic.value as LearningTopic } : {}),
      ...(kind === "other" && note.value.trim() ? { note: note.value.trim() } : {}),
    };
    message.replaceChildren(h("p", { class: "muted" }, "Verificando…"));
    api
      .createJourney(url.value, goal)
      .then(({ id, startOrder }) => {
        location.hash = startOrder ? stageHref(id, startOrder) : `#/j/${id}`;
      })
      .catch((error: unknown) => {
        if (!(error instanceof ApiError)) return message.replaceChildren(h("p", { class: "fail" }, "Falha ao criar a jornada."));
        const fallback = fallbackId(error.body);
        message.replaceChildren(
          h("p", {}, error.message),
          ...(fallback ? [h("a", { class: "btn", href: `#/j/${fallback}` }, "Aprender o projeto do zero →")] : []),
        );
      });
  });

  return h(
    "article",
    { class: "home" },
    h("h1", {}, "OWNR"),
    h("p", { class: "subtitle" }, "Propriedade técnica sobre código que você não conhece: o menor caminho até entender, reconstruir e mudar com segurança."),
    h("p", { class: "muted tagline" }, "Own the code. Direct the agents."),
    resume
      ? h("aside", { class: "resume" }, h("p", {}, "Continuar ", h("strong", {}, resume.journey.title), ` — ${resume.label}`), h("a", { class: "btn primary", href: `#/j/${resume.journey.id}` }, "Continuar"))
      : null,
    form,
    message,
    journeys.length
      ? h("details", { class: "journeys-list" }, h("summary", { class: "muted" }, "Jornadas já disponíveis"), h("ul", { class: "journeys" }, ...journeys.map((j) => h("li", {}, h("a", { href: `#/j/${j.id}` }, j.title), h("span", { class: "muted" }, ` · ${j.stageCount} etapas`)))))
      : null,
  );
}

function fallbackId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("fallback" in body)) return undefined;
  const fallback = body.fallback;
  return typeof fallback === "object" && fallback !== null && "id" in fallback && typeof fallback.id === "string" ? fallback.id : undefined;
}
