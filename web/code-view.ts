import type { TutorSelection } from "../src/domain/tutor.ts";
import { h } from "./dom.ts";
import { highlightLines } from "./highlight.ts";

/** Read-only, highlighted code with real line numbers (firstLine) for selection mapping. */
export function codeView(file: string, source: string, firstLine = 1): HTMLElement {
  const lines = highlightLines(source);
  const body = lines
    .map((html, index) => `<div class="ln" data-line="${firstLine + index}"><span class="no">${firstLine + index}</span><span class="src">${html || " "}</span></div>`)
    .join("");
  return h("div", { class: "code", "data-file": file, html: body });
}

/** Maps the current DOM selection inside a codeView to a tutor selection. */
export function selectionFromCodeView(): TutorSelection | undefined {
  const selection = window.getSelection();
  const text = selection?.toString() ?? "";
  if (!selection || selection.rangeCount === 0 || !text.trim()) return undefined;
  const lineOf = (node: Node | null): Element | null =>
    (node instanceof Element ? node : node?.parentElement ?? null)?.closest("[data-line]") ?? null;
  const start = lineOf(selection.anchorNode);
  const end = lineOf(selection.focusNode);
  const view = start?.closest<HTMLElement>(".code");
  if (!start || !end || !view || view !== end.closest(".code")) return undefined;
  const a = Number(start.getAttribute("data-line"));
  const b = Number(end.getAttribute("data-line"));
  return {
    file: view.dataset.file ?? "código",
    startLine: Math.min(a, b),
    endLine: Math.max(a, b),
    // Line numbers are user-select: none, so they never enter the selected text.
    text: text.slice(0, 4_000),
  };
}
