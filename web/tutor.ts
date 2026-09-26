import type { TutorSelection } from "../src/domain/tutor.ts";
import { ApiError, api, type StageDetail } from "./api.ts";
import { h } from "./dom.ts";
import { highlightLines } from "./highlight.ts";
import { md } from "./md.ts";

type Message = { role: "user" | "assistant"; content: string; selection?: TutorSelection; source?: "llm" | "offline" };
type Thread = { id?: string; messages: Message[] };

export type TutorPanel = {
  setStage(stage: StageDetail, suggestions: string[]): void;
  idle(): void;
  attach(selection: TutorSelection): void;
  ask(message: string, selection?: TutorSelection): void;
  focus(): void;
};

export function mountTutor(root: HTMLElement): TutorPanel {
  const threads = new Map<string, Thread>();
  let stage: StageDetail | undefined;
  let attached: TutorSelection | undefined;
  let pending = false;
  let suggestions: string[] = [];

  const title = h("span", { class: "muted" });
  const log = h("div", { class: "tutor-log", role: "log", "aria-live": "polite" });
  const chip = h("div", { class: "chip-row" });
  const input = h("textarea", { class: "tutor-input", rows: 2, placeholder: "Pergunte sobre esta etapa…  (Ctrl/⌘ K)", "aria-label": "Pergunta ao tutor" });
  const send = h("button", { class: "btn primary small", type: "submit" }, "Enviar");
  const form = h("form", { class: "tutor-form" }, chip, h("div", { class: "tutor-row" }, input, send));

  root.replaceChildren(h("div", { class: "panel-head" }, h("h2", {}, "Tutor"), title), log, form);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  function thread(): Thread | undefined {
    if (!stage) return undefined;
    let current = threads.get(stage.id);
    if (!current) {
      current = { messages: [] };
      threads.set(stage.id, current);
    }
    return current;
  }

  function submit(): void {
    const text = input.value.trim();
    if (!text && !attached) return;
    ask(text || "Explique este trecho.", attached);
    input.value = "";
  }

  function ask(message: string, selection?: TutorSelection): void {
    const current = thread();
    if (!stage || !current || pending) return;
    const stageId = stage.id;
    current.messages.push({ role: "user", content: message, ...(selection ? { selection } : {}) });
    attached = undefined;
    pending = true;
    render();
    api
      .tutor(stageId, message, selection, current.id)
      .then((reply) => {
        current.id = reply.threadId;
        current.messages.push({ role: "assistant", content: reply.reply, source: reply.source });
      })
      .catch((error: unknown) => {
        const text = error instanceof ApiError ? error.message : "Não consegui responder agora. Tente de novo.";
        current.messages.push({ role: "assistant", content: text });
      })
      .finally(() => {
        pending = false;
        if (stage?.id === stageId) render();
      });
  }

  function render(): void {
    const current = thread();
    send.disabled = pending;
    chip.replaceChildren(
      attached
        ? h(
            "span",
            { class: "chip" },
            `${attached.file}:${attached.startLine}${attached.endLine !== attached.startLine ? "-" + attached.endLine : ""}`,
            h("button", { type: "button", class: "chip-x", "aria-label": "Remover trecho", onclick: () => { attached = undefined; render(); } }, "×"),
          )
        : "",
    );
    if (!current || current.messages.length === 0) {
      log.replaceChildren(
        h(
          "div",
          { class: "tutor-empty" },
          h("p", {}, "Pergunte qualquer coisa sobre ", h("strong", {}, "esta etapa"), "."),
          h("p", { class: "muted" }, "Dica: selecione código e clique em ", h("kbd", {}, "Explain"), "."),
          h(
            "div",
            { class: "suggestions" },
            suggestions.map((q) => h("button", { type: "button", class: "link", onclick: () => ask(q) }, q)),
          ),
        ),
      );
      return;
    }
    log.replaceChildren(
      ...current.messages.map((m) =>
        h(
          "div",
          { class: `msg ${m.role}` },
          m.selection ? h("pre", { class: "snippet quote", html: highlightLines(m.selection.text).join("\n") }) : null,
          h("div", { class: "msg-body", html: md(m.content) }),
          m.source === "offline" ? h("div", { class: "badge", title: "Sem LLM configurado: resposta montada a partir do material da etapa." }, "tutor offline") : null,
        ),
      ),
      pending ? h("div", { class: "msg assistant typing", "aria-label": "Respondendo" }, h("span"), h("span"), h("span")) : "",
    );
    log.scrollTop = log.scrollHeight;
  }

  return {
    setStage(next, nextSuggestions) {
      stage = next;
      suggestions = nextSuggestions;
      attached = undefined;
      title.textContent = next.title;
      render();
    },
    idle() {
      stage = undefined;
      attached = undefined;
      title.textContent = "";
      chip.replaceChildren();
      log.replaceChildren(h("p", { class: "muted tutor-empty" }, "Abra uma etapa: o tutor responde sobre ela e as anteriores."));
    },
    attach(selection) {
      attached = selection;
      render();
      input.focus();
    },
    ask,
    focus: () => input.focus(),
  };
}
