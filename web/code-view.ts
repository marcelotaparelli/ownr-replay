import type { TutorSelection } from "../src/domain/tutor.ts";
import { h } from "./dom.ts";
import { highlightLines } from "./highlight.ts";

export type CodeViewOptions = {
  /** Real line number of the first line (production excerpts). */
  firstLine?: number;
  /** Lines (1-based, relative) added in this step. */
  newLines?: ReadonlySet<number>;
  /** Called when a line is clicked, with its relative number and source text. */
  onLine?: (line: number, text: string) => void;
};

/** Read-only, highlighted code with line numbers; selections map back to file + lines. */
export function codeView(file: string, source: string, options: CodeViewOptions = {}): HTMLElement {
  const first = options.firstLine ?? 1;
  // Files end with a newline; showing it as an empty numbered line is noise.
  source = source.replace(/\n$/, "");
  const html = highlightLines(source);
  const body = html
    .map((line, index) => {
      const added = options.newLines?.has(index + 1) ? " new" : "";
      return `<div class="ln${added}" data-line="${first + index}"><span class="no">${first + index}</span><span class="src">${line || " "}</span></div>`;
    })
    .join("");
  const view = h("div", { class: "code" + (options.onLine ? " clickable" : ""), "data-file": file, html: body });
  const onLine = options.onLine;
  if (onLine) {
    const lines = source.split("\n");
    view.addEventListener("click", (event) => {
      // A drag-selection is for the tutor, not a line click.
      if (window.getSelection()?.toString()) return;
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>(".ln") : null;
      if (!row) return;
      const line = Number(row.dataset.line) - first + 1;
      view.querySelector(".ln.selected")?.classList.remove("selected");
      row.classList.add("selected");
      onLine(line, lines[line - 1] ?? "");
    });
  }
  return view;
}

/** Lines of `current` that did not exist in `previous` (compared by trimmed text, respecting repeats). */
export function addedLines(previous: string | undefined, current: string): Set<number> {
  const added = new Set<number>();
  if (previous === undefined) return added;
  const remaining = new Map<string, number>();
  for (const line of previous.split("\n")) remaining.set(line.trim(), (remaining.get(line.trim()) ?? 0) + 1);
  current.split("\n").forEach((line, index) => {
    const key = line.trim();
    if (!key || /^[{}()[\];,]+$/.test(key)) return;
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else added.add(index + 1);
  });
  return added;
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
