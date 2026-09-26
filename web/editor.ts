import type { TutorSelection } from "../src/domain/tutor.ts";
import { h } from "./dom.ts";
import { highlightLines } from "./highlight.ts";

const INDENT = "  ";
const OPENERS = /[{([]\s*$/;

export type Editor = {
  element: HTMLElement;
  value(): string;
  setValue(source: string): void;
  focus(): void;
  selection(): TutorSelection | undefined;
};

/**
 * A textarea layered over highlighted code. Both grow with the content,
 * so there is no scroll syncing: the page scrolls, the wrapper scrolls
 * horizontally. Enough editor for exercises of a few dozen lines.
 */
export function createEditor(file: string, initial: string, options: { readOnly?: boolean; onChange?: (source: string) => void } = {}): Editor {
  const gutter = h("div", { class: "gutter", "aria-hidden": "true" });
  const highlighted = h("pre", { class: "hl", "aria-hidden": "true" });
  const input = h("textarea", {
    class: "input",
    spellcheck: "false",
    autocapitalize: "off",
    autocomplete: "off",
    wrap: "off",
    "aria-label": `Editor de ${file}`,
    readonly: options.readOnly ?? false,
  });
  input.value = initial;
  const element = h("div", { class: "editor" + (options.readOnly ? " readonly" : "") }, gutter, h("div", { class: "layers" }, highlighted, input));

  const render = (): void => {
    const source = input.value;
    const lines = source.split("\n");
    highlighted.innerHTML = highlightLines(source).join("\n") + "\n";
    gutter.textContent = lines.map((_, i) => i + 1).join("\n");
    input.rows = lines.length;
    input.style.width = `${Math.max(...lines.map((line) => line.length)) + 4}ch`;
  };

  input.addEventListener("input", () => {
    render();
    options.onChange?.(input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (options.readOnly || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      insert(input, INDENT);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const lineStart = input.value.lastIndexOf("\n", input.selectionStart - 1) + 1;
      const before = input.value.slice(lineStart, input.selectionStart);
      const indent = /^\s*/.exec(before)?.[0] ?? "";
      insert(input, "\n" + indent + (OPENERS.test(before) ? INDENT : ""));
    }
  });
  render();

  return {
    element,
    value: () => input.value,
    setValue(source) {
      input.value = source;
      render();
      options.onChange?.(source);
    },
    focus: () => input.focus(),
    selection() {
      const { selectionStart: start, selectionEnd: end, value } = input;
      const text = value.slice(start, end);
      if (!text.trim()) return undefined;
      const lineAt = (offset: number) => value.slice(0, offset).split("\n").length;
      return { file, startLine: lineAt(start), endLine: lineAt(end), text: text.slice(0, 4_000) };
    },
  };
}

/** execCommand keeps the native undo stack; setRangeText is the fallback. */
function insert(input: HTMLTextAreaElement, text: string): void {
  if (!document.execCommand("insertText", false, text)) {
    input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input"));
  }
}
