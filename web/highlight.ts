import { escapeHtml } from "./dom.ts";

const KEYWORDS = new Set(
  ("abstract as async await break case catch class const constructor continue default delete do else enum export extends " +
    "false finally for from function if implements import in instanceof interface let new null of private protected public " +
    "readonly return static super switch this throw true try type typeof undefined var void while yield satisfies override keyof").split(" "),
);

// Order matters: comments and strings before regex literals and operators.
const TOKEN = new RegExp(
  [
    String.raw`(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)`,
    String.raw`(?<string>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60)`,
    String.raw`(?<regex>(?<=^|[=(,:\[!&|?{};]\s*|return\s+)\/(?![*/])(?:[^/\\\n\[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*)`,
    String.raw`(?<number>\b\d[\d_]*(?:\.\d+)?\b)`,
    String.raw`(?<word>[A-Za-z_$][\w$]*)`,
  ].join("|"),
  "g",
);

/** Returns one HTML string per source line; tokens never span lines. */
export function highlightLines(source: string): string[] {
  let html = "";
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    html += escapeHtml(source.slice(last, index));
    const text = match[0];
    const groups = match.groups ?? {};
    let cls: string | undefined;
    if (groups.comment) cls = "c";
    else if (groups.string) cls = "s";
    else if (groups.regex) cls = "r";
    else if (groups.number) cls = "n";
    else if (groups.word) {
      if (KEYWORDS.has(text)) cls = "k";
      else if (/^[A-Z]/.test(text)) cls = "t";
      else if (source[index + text.length] === "(") cls = "f";
    }
    html += cls ? wrapPerLine(text, cls) : escapeHtml(text);
    last = index + text.length;
  }
  html += escapeHtml(source.slice(last));
  return html.split("\n");
}

function wrapPerLine(text: string, cls: string): string {
  return text
    .split("\n")
    .map((part) => (part ? `<span class="${cls}">${escapeHtml(part)}</span>` : ""))
    .join("\n");
}
