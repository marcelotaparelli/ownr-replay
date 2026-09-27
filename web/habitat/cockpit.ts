import type { Candidate, Decision, EvaluationResult, FileChange, Measurement } from "../../src/habitat/domain.ts";
import type { HabitatEvent } from "../../src/habitat/store.ts";
import { $, h } from "../dom.ts";

/**
 * The Cockpit: where the organism is, where it should be, what the envelope allows,
 * which candidates exist, why each one was decided — and a human hand on promotion.
 */

type State = Awaited<ReturnType<typeof import("../../src/habitat/http.ts").snapshot>>;
type CandidateDetail = {
  candidate: Candidate;
  changes: FileChange[];
  evaluations: EvaluationResult[];
  baselineEvaluations: EvaluationResult[];
  decision: Decision | null;
  diff: string | null;
  events: HabitatEvent[];
};

let state: State | null = null;
let selected: string | null = null;
let message = "";

async function api<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  const response = await fetch(path, init ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : undefined);
  const body = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body;
}

const badge = (status: string, label = status) => h("span", { class: `badge s-${status}` }, label);
const fmt = (m: Pick<Measurement, "value" | "unit"> | undefined) => (m?.value === null || m?.value === undefined ? "—" : `${m.value}${m.unit ? ` ${m.unit}` : ""}`);
const time = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR");

async function refresh(): Promise<void> {
  try {
    state = await api<State>("/api/state");
    render();
    if (selected) await renderCandidate(selected);
    const events = await api<{ events: HabitatEvent[] }>("/api/events");
    renderRecorder(events.events);
  } catch (error) {
    message = `Falha ao ler o estado: ${String(error)}`;
    render();
  }
}

async function act(run: () => Promise<unknown>): Promise<void> {
  message = "";
  try {
    await run();
  } catch (error) {
    message = String(error instanceof Error ? error.message : error);
  }
  await refresh();
}

function render(): void {
  if (!state) return;
  const s = state;
  $("#organism").textContent = `${s.organism.name} · missão ${s.mission.id}`;
  const running = $("#running");
  running.hidden = !s.running;
  running.textContent = s.running ? `executando ${s.running}…` : "";

  const baselineMeasurements = new Map((s.baseline?.evaluations ?? []).flatMap((e) => e.measurements).map((m) => [m.metric, m]));

  $("#mission").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Missão"),
      h("p", {}, s.mission.objective),
      h("p", { class: "muted" }, s.mission.reached ? "Estado desejado alcançado." : "Estado desejado ainda não alcançado — nunca declarado sem dados suficientes."),
      h(
        "table",
        {},
        h("tr", {}, h("th", {}, "Estado desejado"), h("th", {}, "Atual"), h("th", {}, "Alvo"), h("th", {}, "")),
        s.progress.map((p) =>
          h(
            "tr",
            {},
            h("td", {}, p.label),
            h("td", { class: "num" }, p.value === null ? "—" : `${p.value}${p.unit ? ` ${p.unit}` : ""}`, p.sampleSize === undefined ? "" : h("div", { class: "muted" }, `n=${p.sampleSize}${p.minSampleSize ? `/${p.minSampleSize}` : ""}`)),
            h("td", { class: "num" }, `${p.operator} ${p.target}`),
            h("td", {}, badge(p.status)),
          ),
        ),
      ),
      h("h3", {}, "Fitness"),
      h("p", { class: "muted" }, "Objetivos (comparados com a baseline):"),
      h("ul", {}, s.mission.fitness.objectives.map((o) => h("li", {}, `${o.direction === "minimize" ? "↓" : "↑"} ${o.label} — baseline ${fmt(baselineMeasurements.get(o.metric))}`))),
      h("p", { class: "muted" }, "Contra-métricas (anti-Goodhart):"),
      h("ul", {}, s.mission.fitness.guards.map((g) => h("li", {}, `${g.label} ${g.operator} ${g.threshold} — ${g.reason}`))),
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Baseline"),
      s.baseline
        ? h("p", {}, h("span", { class: "mono" }, s.baseline.revision.slice(0, 10)), ` observada às ${time(s.baseline.createdAt)}`)
        : h("p", { class: "muted" }, "Ainda não observada."),
      s.baseline ? h("div", { class: "row" }, s.baseline.evaluations.map((e) => badge(e.status, `${e.evaluatorId} ${e.status}`))) : null,
      h("p", {}, h("button", { disabled: Boolean(s.running), onclick: () => act(() => api("/api/baseline/observe", { method: "POST", body: {} })) }, "Observar baseline")),
    ),
  );

  const baselineEvaluations = new Map((s.baseline?.evaluations ?? []).map((e) => [e.evaluatorId, e]));
  $("#envelope").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, `Envelope · ${s.mission.envelope.id}`),
      h(
        "table",
        {},
        h("tr", {}, h("th", {}, ""), h("th", {}, "Restrição"), h("th", {}, "Baseline")),
        s.mission.envelope.constraints.map((c) =>
          h("tr", {}, h("td", {}, badge(c.severity, c.severity.toUpperCase())), h("td", {}, c.name, c.metric ? h("div", { class: "muted mono" }, `${c.metric} ${c.operator} ${c.threshold}`) : null), h("td", {}, badge(baselineEvaluations.get(c.evaluatorId)?.status ?? "NOT_RUN"))),
        ),
        s.mission.envelope.uncovered.map((u) => h("tr", {}, h("td", {}, badge("NOT_RUN")), h("td", {}, u.name, h("div", { class: "muted" }, u.reason)), h("td", {}, badge("NOT_RUN")))),
      ),
      h("p", { class: "muted" }, "Candidates só podem alterar: ", h("span", { class: "mono" }, s.organism.allowedPaths.join(", "))),
    ),
  );

  $("#evolution").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Evolução"),
      h(
        "ul",
        { class: "tree" },
        h(
          "li",
          {},
          h("span", { class: "mono" }, s.baseline ? `baseline ${s.baseline.revision.slice(0, 10)}` : "baseline não observada"),
          h(
            "ul",
            {},
            s.candidates.map((c) =>
              h(
                "li",
                {},
                h(
                  "button",
                  { class: "node", "aria-current": String(c.id === selected), onclick: () => select(c.id) },
                  h("span", { class: "mono" }, c.id),
                  h("span", {}, c.proposalId),
                  badge(c.verdict ?? c.status, c.verdict ?? c.status),
                  c.status === "promoted" ? badge("promoted", "promovido") : null,
                ),
              ),
            ),
          ),
        ),
      ),
      h("h3", {}, "Propostas"),
      h(
        "table",
        {},
        s.proposals.map((p) =>
          h(
            "tr",
            {},
            h("td", {}, h("strong", {}, p.id), h("div", { class: "muted" }, p.hypothesis), h("div", { class: "muted" }, `origem: ${p.source.kind} · ${p.source.author} · ${p.patchLines} linhas de patch`)),
            h(
              "td",
              {},
              h("button", { disabled: Boolean(s.running) || !s.baseline, onclick: () => act(() => api(`/api/proposals/${encodeURIComponent(p.id)}/candidate`, { method: "POST", body: {} })) }, "Avaliar"),
            ),
          ),
        ),
      ),
      message ? h("p", { class: "error", role: "alert" }, message) : null,
    ),
  );
}

async function select(id: string): Promise<void> {
  selected = id;
  render();
  await renderCandidate(id);
}

async function renderCandidate(id: string): Promise<void> {
  const d = await api<CandidateDetail>(`/api/candidates/${encodeURIComponent(id)}`);
  const c = d.candidate;
  const who = h("input", { "aria-label": "Quem promove", placeholder: "seu nome", size: 14 });
  const decision = d.decision;
  $("#candidate").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, `Candidate ${c.id}`),
      h("p", {}, c.hypothesis),
      h("p", { class: "muted" }, `geração ${c.generation} · pai ${c.parentRevision.slice(0, 10)} · revisão ${c.revision?.slice(0, 10) ?? "—"} · origem ${c.source.kind} (${c.source.author})`),
      c.claims ? h("p", { class: "claims" }, h("strong", {}, "Alegação do autor (não é evidência): "), c.claims) : null,
      decision
        ? [
            h("div", { class: "verdict" }, badge(decision.verdict, decision.verdict), " ", h("span", { class: "muted" }, `status ${c.status}`)),
            h("ul", {}, decision.reasons.map((r) => h("li", {}, r))),
            h("h3", {}, "Envelope"),
            h("table", {}, decision.constraints.map((k) => h("tr", {}, h("td", {}, badge(k.severity, k.severity.toUpperCase())), h("td", {}, k.name), h("td", {}, badge(k.status)), h("td", { class: "muted" }, k.detail)))),
            h("h3", {}, "Fitness (baseline → candidate)"),
            h(
              "table",
              {},
              decision.comparisons.map((m) => h("tr", {}, h("td", {}, m.label), h("td", { class: "num" }, `${m.baseline ?? "—"} → ${m.candidate ?? "—"}`), h("td", {}, badge(m.outcome)))),
              decision.guards.map((g) => h("tr", {}, h("td", {}, `contra-métrica: ${g.label}`), h("td", { class: "num" }, `${g.value ?? "—"} (${g.operator} ${g.threshold})`), h("td", {}, badge(g.status)))),
            ),
          ]
        : h("p", { class: "muted" }, "Sem decisão ainda."),
      c.status === "promotable"
        ? h(
            "div",
            { class: "row" },
            h("span", {}, "Promover publica a branch local ", h("span", { class: "mono" }, `habitat/${c.id}`), " para revisão. Não faz merge, push nem deploy."),
            who,
            h("button", { class: "primary", onclick: () => act(() => api(`/api/candidates/${encodeURIComponent(c.id)}/promote`, { method: "POST", body: { by: who.value } })) }, "Promover"),
          )
        : null,
      h("h3", {}, "Avaliações independentes"),
      d.evaluations.map((e) =>
        h(
          "details",
          {},
          h("summary", {}, badge(e.status), ` ${e.evaluatorId} · ${e.durationMs} ms`, e.errors[0] ? h("span", { class: "muted" }, ` — ${e.errors[0]}`) : null),
          e.measurements.length ? h("table", {}, e.measurements.map((m) => h("tr", {}, h("td", { class: "mono" }, m.metric), h("td", { class: "num" }, fmt(m)), h("td", {}, m.status === "MEASURED" ? "" : badge(m.status))))) : null,
          e.evidence.map((ev) => [h("p", {}, ev.summary), ev.detail ? h("pre", {}, ev.detail) : null]),
        ),
      ),
      h("h3", {}, `Arquivos alterados (${d.changes.length})`),
      h("ul", { class: "mono" }, d.changes.map((f) => h("li", {}, `${f.status} ${f.path}`))),
      d.diff ? h("details", {}, h("summary", {}, "Diff"), h("pre", {}, d.diff)) : null,
    ),
  );
}

function renderRecorder(events: HabitatEvent[]): void {
  $("#recorder").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Gravador de voo"),
      h(
        "ul",
        { class: "events" },
        events.map((e) =>
          h(
            "li",
            {},
            h("time", {}, time(e.createdAt)),
            h("strong", {}, e.kind),
            e.candidateId ? h("span", { class: "mono" }, ` ${e.candidateId}`) : null,
            e.data ? h("div", { class: "muted" }, summarize(e.data)) : null,
          ),
        ),
      ),
    ),
  );
}

function summarize(data: Record<string, unknown>): string {
  const text = Object.entries(data)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

await refresh();
// Jobs take minutes; poll gently, faster while one runs.
const tick = async (): Promise<void> => {
  await refresh();
  setTimeout(() => void tick(), state?.running ? 2000 : 10_000);
};
setTimeout(() => void tick(), 2000);
