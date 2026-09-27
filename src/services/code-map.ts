import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ArchitectureNode } from "../domain/architecture.ts";
import type { Journey } from "../domain/journey.ts";
import type { Stage } from "../domain/stage.ts";

/**
 * Architecture node → real code. Only real references are used: declarations found in the copy of
 * the repository at the pinned SHA (data/golden/<journey>/original), the stages' curated
 * originalCodeRefs, and the journey's explicit codeMap (validated against those declarations at load).
 * A node none of them covers is reported as unmapped — never guessed.
 */

export type Declaration = { path: string; symbol: string; container: string | null; startLine: number; endLine: number };
export type RepositoryIndex = { files: Map<string, string>; declarations: Declaration[] };

export type CodeOption = {
  path: string;
  /** As shown: "Class.method" for members. */
  symbol: string;
  startLine: number;
  endLine: number;
  /** How this option was found. */
  basis: "journey-map" | "curated-ref" | "same-name";
};

export type NodeCode =
  | { nodeId: string; label: string; status: "mapped"; options: CodeOption[] }
  | { nodeId: string; label: string; status: "unmapped"; reason: string };

const TOP_LEVEL = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|function|const|let|type|enum)\s+([A-Za-z_$][\w$]*)/;
const MEMBER = /^\s+(?:(?:public|private|protected|readonly|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/;
const NOT_MEMBERS = new Set(["if", "for", "while", "switch", "return", "catch", "constructor", "super", "function"]);

export function indexRepository(root: string): RepositoryIndex {
  const files = new Map<string, string>();
  const declarations: Declaration[] = [];
  if (!existsSync(root)) return { files, declarations };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.set(relative(root, full), readFileSync(full, "utf8"));
    }
  };
  walk(root);
  for (const [path, content] of files) declarations.push(...declarationsOf(path, content));
  return { files, declarations };
}

/** Top-level declarations, and members of classes and interfaces, with the lines they span. */
export function declarationsOf(path: string, content: string): Declaration[] {
  const lines = content.split("\n");
  const found: Declaration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = TOP_LEVEL.exec(lines[i] ?? "");
    if (!match) continue;
    const [, kind = "", symbol = ""] = match;
    const end = endOf(lines, i);
    found.push({ path, symbol, container: null, startLine: i + 1, endLine: end + 1 });
    if (kind !== "class" && kind !== "interface") continue;
    let depth = 0;
    for (let j = i; j <= end; j++) {
      const line = lines[j] ?? "";
      const member = depth === 1 ? MEMBER.exec(line) : null;
      if (member?.[1] && !NOT_MEMBERS.has(member[1])) found.push({ path, symbol: member[1], container: symbol, startLine: j + 1, endLine: endOf(lines, j) + 1 });
      depth += braceDelta(line);
    }
  }
  return found;
}

/** Last line (0-based) of the construct starting at `start`: its braces balance, or its statement ends. */
function endOf(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    depth += braceDelta(line);
    if (line.includes("{")) opened = true;
    if (opened && depth <= 0) return i;
    if (!opened && depth === 0 && /;\s*$/.test(line)) return i;
  }
  return lines.length - 1;
}

/** Braces outside strings and line comments; good enough for declaration spans, not a parser. */
function braceDelta(line: string): number {
  let delta = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && line[i + 1] === "/") break;
    else if (c === "{") delta++;
    else if (c === "}") delta--;
  }
  return delta;
}

/** "scoreCategory()" → exact name; "Deterministic…" / "Prisma…Repository" → prefix/suffix pattern. */
function matcher(label: string): ((name: string) => boolean) | null {
  const clean = label.replace(/\(\)$/, "").trim();
  if (!/^[A-Za-z_$][\w$]*(…[\w$]*)?$|^[A-Za-z_$][\w$]*…$/.test(clean)) return null;
  if (!clean.includes("…")) return (name) => name === clean;
  const [prefix = "", suffix = ""] = clean.split("…");
  return (name) => name.length > prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix);
}

const shown = (d: Declaration) => (d.container ? `${d.container}.${d.symbol}` : d.symbol);

export function resolveNode(node: ArchitectureNode, journey: Journey, index: RepositoryIndex): NodeCode {
  const options: CodeOption[] = [];
  const add = (option: CodeOption): void => {
    if (!options.some((o) => o.path === option.path && o.symbol === option.symbol)) options.push(option);
  };

  for (const entry of journey.codeMap[node.id] ?? []) {
    const d = index.declarations.find((x) => x.path === entry.path && shown(x) === entry.symbol);
    if (d) add({ path: d.path, symbol: shown(d), startLine: d.startLine, endLine: d.endLine, basis: "journey-map" });
  }
  if (options.length) return { nodeId: node.id, label: node.label, status: "mapped", options };

  const matches = matcher(node.label);
  const refs = journey.stages.flatMap((s: Stage) => s.originalCodeRefs);
  for (const ref of refs) {
    const byName = matches ? matches(ref.symbol) || (ref.replaySymbol !== undefined && matches(ref.replaySymbol)) : false;
    if ((byName || ref.symbol === node.label) && index.files.has(ref.path)) add({ path: ref.path, symbol: ref.symbol, startLine: ref.startLine, endLine: ref.endLine, basis: "curated-ref" });
  }
  if (matches) {
    for (const d of index.declarations) if (matches(d.symbol)) add({ path: d.path, symbol: shown(d), startLine: d.startLine, endLine: d.endLine, basis: "same-name" });
  }
  if (options.length) return { nodeId: node.id, label: node.label, status: "mapped", options };
  return {
    nodeId: node.id,
    label: node.label,
    status: "unmapped",
    reason: node.kind === "external" || node.kind === "infra" ? "componente externo ao código do repositório" : "nenhum símbolo com esse nome no repositório real, nem mapeamento declarado",
  };
}

/** Every explicit mapping must point at a declaration that exists at the pinned SHA, for a node that exists. */
export function codeMapProblems(journey: Journey, index: RepositoryIndex): string[] {
  const nodeIds = new Set(journey.stages.flatMap((s) => s.architecture?.nodes.map((n) => n.id) ?? []));
  return Object.entries(journey.codeMap).flatMap(([nodeId, entries]) => [
    ...(nodeIds.has(nodeId) ? [] : [`codeMap: nó "${nodeId}" não existe em nenhuma arquitetura`]),
    ...entries
      .filter((e) => !index.declarations.some((d) => d.path === e.path && shown(d) === e.symbol))
      .map((e) => `codeMap: "${nodeId}" aponta para ${e.path}#${e.symbol}, que não existe no repositório real`),
  ]);
}

export const originalDir = (journeyDir: string): string => join(journeyDir, "original");
