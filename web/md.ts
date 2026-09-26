import { escapeHtml } from "./dom.ts";
import { highlightLines } from "./highlight.ts";

/** Just enough markdown for pedagogical text: paragraphs, lists, fences, `code`, **bold**, _em_. */
export function mdInline(source: string): string {
  return inline(source);
}

export function md(source: string): string {
  const blocks: string[] = [];
  const parts = source.split(/```[a-z]*[^\n]*\n([\s\S]*?)```/g);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push(`<pre class="snippet">${highlightLines(part.replace(/\n$/, "")).join("\n")}</pre>`);
      return;
    }
    for (const chunk of part.split(/\n{2,}/)) {
      const text = chunk.trim();
      if (!text) continue;
      const lines = text.split("\n");
      if (lines.every((line) => /^\s*- /.test(line))) {
        blocks.push("<ul>" + lines.map((line) => `<li>${inline(line.replace(/^\s*- /, ""))}</li>`).join("") + "</ul>");
      } else {
        blocks.push(`<p>${inline(text).replace(/\n/g, "<br>")}</p>`);
      }
    }
  });
  return blocks.join("");
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])[_*]([^_*\s][^_*]*)[_*](?=[\s).,;:]|$)/g, "$1<em>$2</em>");
}
