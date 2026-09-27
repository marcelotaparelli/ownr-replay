import type { ArchitectureGraph, Relation } from "../src/domain/architecture.ts";
import type { CodeOption, NodeCode } from "../src/services/code-map.ts";
import type { ArchitectureCode } from "./api.ts";
import { codeView } from "./code-view.ts";
import { h } from "./dom.ts";
import { clampWidth, clearWidth, resizeHandle, saveWidth, storedWidth } from "./panel-resize.ts";

const BASIS: Record<CodeOption["basis"], string> = {
  "journey-map": "mapeamento declarado da jornada",
  "curated-ref": "referência curada da jornada",
  "same-name": "mesmo nome no código real",
};

const RELATION: Record<Relation, [outgoing: string, incoming: string]> = {
  flows_to: ["segue para", "vem de"],
  depends_on: ["depende de", "é usado por"],
  implements: ["implementa", "é implementado por"],
  calls: ["chama", "é chamado por"],
  creates: ["produz", "é produzido por"],
  persists: ["persiste", "é persistido por"],
  reads: ["lê", "é lido por"],
  writes: ["grava", "é gravado por"],
  wraps: ["envolve", "é envolvido por"],
  validates: ["valida", "é validado por"],
  routes_to: ["roteia para", "recebe rota de"],
};

let drawer: HTMLElement | null = null;
let restoreFocus: HTMLElement | null = null;
const DRAWER_WIDTH = { key: "ownr.width.code-drawer", default: 760, min: 360, max: 960 };

function drawerBounds(): { min: number; max: number } {
  const min = Math.min(DRAWER_WIDTH.min, window.innerWidth);
  // On small stacked screens the drawer may fill the viewport, as it did before.
  const max = window.innerWidth <= 720 ? window.innerWidth : Math.min(DRAWER_WIDTH.max, window.innerWidth - 420);
  return { min, max: Math.max(min, max) };
}

function addDrawerResize(panel: HTMLElement): HTMLElement {
  const store = window.localStorage;
  let wanted = storedWidth(store, DRAWER_WIDTH.key, DRAWER_WIDTH.default);
  let width = DRAWER_WIDTH.default;
  let handle: HTMLElement;
  const apply = () => {
    width = clampWidth(wanted, drawerBounds().min, drawerBounds().max);
    panel.style.width = `${width}px`;
    panel.style.setProperty("--drawer-width", `${width}px`);
    if (handle) {
      const bounds = drawerBounds();
      handle.setAttribute("aria-valuemin", String(bounds.min));
      handle.setAttribute("aria-valuemax", String(bounds.max));
      handle.setAttribute("aria-valuenow", String(Math.round(width)));
    }
  };
  handle = resizeHandle({
    label: "Largura do painel de código da arquitetura",
    direction: -1,
    bounds: drawerBounds,
    current: () => width,
    set: (next) => { wanted = next; saveWidth(store, DRAWER_WIDTH.key, next); apply(); },
    reset: () => { clearWidth(store, DRAWER_WIDTH.key); wanted = DRAWER_WIDTH.default; apply(); },
  });
  window.addEventListener("resize", apply, { signal: drawerResizeEvents.signal });
  apply();
  return handle;
}

let drawerResizeEvents = new AbortController();

export function closeCodeDrawer(): void {
  drawer?.remove();
  drawer = null;
  drawerResizeEvents.abort();
  drawerResizeEvents = new AbortController();
  document.removeEventListener("keydown", onKey);
  restoreFocus?.focus();
  restoreFocus = null;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeCodeDrawer();
}

/**
 * Architecture → real code, beside the stage (the page and the learner's place in it stay put).
 * Relations only lead to components this stage's diagram already shows.
 */
export function openCodeDrawer(graph: ArchitectureGraph, data: ArchitectureCode, nodeId: string, choice = 0): void {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const code: NodeCode | undefined = data.nodes.find((n) => n.nodeId === nodeId);
  if (!node || !code) return;
  if (!drawer) {
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer = h("aside", { class: "code-drawer", role: "dialog", "aria-modal": "false", "aria-labelledby": "code-drawer-title" });
    document.body.append(drawer);
    drawer.append(addDrawerResize(drawer));
    document.addEventListener("keydown", onKey);
  }
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const go = (id: string) => () => openCodeDrawer(graph, data, id);
  const outgoing = graph.edges.filter((e) => e.from === nodeId).map((e) => h("li", {}, `${RELATION[e.rel][0]} `, h("button", { type: "button", class: "link", onclick: go(e.to) }, label(e.to))));
  const incoming = graph.edges.filter((e) => e.to === nodeId).map((e) => h("li", {}, `${RELATION[e.rel][1]} `, h("button", { type: "button", class: "link", onclick: go(e.from) }, label(e.from))));
  const option = code.status === "mapped" ? (code.options[choice] ?? code.options[0]) : undefined;

  const resize = drawer.querySelector<HTMLElement>(".resize-handle")!;
  drawer.replaceChildren(
    resize,
    h(
      "div",
      { class: "drawer-inner" },
    h(
      "header",
      { class: "drawer-head" },
      h("div", {}, h("p", { class: "eyebrow" }, `arquitetura → código real · ${node.kind}`), h("h2", { id: "code-drawer-title" }, node.label)),
      h("button", { type: "button", class: "close", "aria-label": "Fechar e voltar à etapa", onclick: closeCodeDrawer }, "✕"),
    ),
    outgoing.length || incoming.length ? h("ul", { class: "relations" }, ...outgoing, ...incoming) : null,
    code.status === "unmapped"
      ? h("p", { class: "unmapped-note" }, h("strong", {}, "Não mapeado: "), code.reason, ". Nenhum código é mostrado para não adivinhar.")
      : [
          code.options.length > 1
            ? h(
                "div",
                { class: "options", role: "group", "aria-label": "Mais de um símbolo relevante" },
                h("p", { class: "muted" }, `${code.options.length} símbolos relevantes — escolha:`),
                ...code.options.map((o, i) =>
                  h("button", { type: "button", class: "option", "aria-pressed": String(i === choice), onclick: () => openCodeDrawer(graph, data, nodeId, i) }, h("span", { class: "mono" }, o.symbol), h("span", { class: "muted" }, ` ${o.path}:${o.startLine}`)),
                ),
              )
            : null,
          option ? codeFor(option, data) : null,
        ],
    ),
  );
  // Scroll only the code, so the path, symbol and relations stay in view above it.
  const listing = drawer.querySelector<HTMLElement>(".drawer-code .code");
  const target = listing?.querySelector<HTMLElement>(".ln.focus");
  if (listing && target) listing.scrollTop = Math.max(0, target.offsetTop - listing.clientHeight / 4);
  drawer.querySelector<HTMLElement>(".close")?.focus({ preventScroll: true });
}

function codeFor(option: CodeOption, data: ArchitectureCode): HTMLElement {
  const source = data.files[option.path] ?? "";
  const excerpt = source.split("\n").slice(option.startLine - 1, option.endLine).join("\n");
  const excerptFocus = new Set(Array.from({ length: option.endLine - option.startLine + 1 }, (_, i) => i + 1));
  const fileFocus = new Set(Array.from(excerptFocus, (line) => option.startLine + line - 1));
  const url = `${data.repo.url}/blob/${data.repo.sha}/${option.path}#L${option.startLine}-L${option.endLine}`;
  let listing = codeView(option.path, excerpt, { firstLine: option.startLine, focusLines: excerptFocus, preserveTrailingLine: true });
  const toggle = h("button", { type: "button", class: "link", "aria-expanded": "false" }, "Ver arquivo completo");
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    const next = expanded
      ? codeView(option.path, excerpt, { firstLine: option.startLine, focusLines: excerptFocus, preserveTrailingLine: true })
      : codeView(option.path, source, { focusLines: fileFocus });
    listing.replaceWith(next);
    listing = next;
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.textContent = expanded ? "Ver arquivo completo" : "Ver apenas trecho";
    if (!expanded) {
      const target = listing.querySelector<HTMLElement>(".ln.focus");
      if (target) listing.scrollTop = Math.max(0, target.offsetTop - listing.clientHeight / 4);
    }
  });
  return h(
    "div",
    { class: "drawer-code" },
    h(
      "p",
      { class: "where" },
      h("span", { class: "mono" }, `${option.path}:${option.startLine}–${option.endLine}`),
      " · ",
      h("strong", { class: "mono" }, option.symbol),
      h("span", { class: "muted" }, ` · ${BASIS[option.basis]} · `),
      h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, `GitHub @${data.repo.sha.slice(0, 7)} ↗`),
    ),
    h("p", { class: "muted" }, "O arquivo completo pode conter conceitos ainda não apresentados. ", toggle),
    listing,
  );
}
