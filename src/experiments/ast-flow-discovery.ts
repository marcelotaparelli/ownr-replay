import type { CodeSymbol, ExternalCall, FlowEdge, FlowIntent } from "../services/flow-discovery.ts";
import { tokenizeGoal, wordsOf } from "../services/flow-discovery.ts";
import { keyOf, type GraphDeclaration } from "./ast-facts.ts";

/**
 * SPIKE (not product): the SELECTION half of services/flow-discovery.ts, ported unchanged so that the only thing
 * that differs between the two engines is the graph they walk. Relevance is the product's own (tokenizeGoal /
 * wordsOf are imported; the 5-letter-prefix rule is a verbatim copy of its private `related`). What was ported:
 * outermostRelevant, shortestPath, extendPath, edgeRelevance, the density ranking, externalBoundary's scoring.
 * Parity with the product on the regex graph was checked outside the repo (same 15 repositories, same chains).
 */

export type SelectionInput = {
  declarations: readonly GraphDeclaration[];
  callable: ReadonlySet<string>;
  edgesFrom: ReadonlyMap<string, FlowEdge[]>;
  externals: ReadonlyMap<string, ExternalCall[]>;
  entries: readonly CodeSymbol[];
};
export type AstFlowPath = { goal: string; intent: FlowIntent; keywords: string[]; entry: CodeSymbol; target: CodeSymbol; chain: CodeSymbol[]; edges: FlowEdge[]; external: ExternalCall | null };

const MAX_HOPS = 6;

const related = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 5;
};
const anyRelated = (words: Iterable<string>, token: string): boolean => {
  for (const word of words) if (related(word, token)) return true;
  return false;
};

const toSymbol = (d: GraphDeclaration): CodeSymbol => ({ path: d.path, symbol: d.symbol, container: d.container, startLine: d.startLine, endLine: d.endLine });

/** One concept per meaningful goal word (what the product's private goalConcepts returns), recovered through its public tokenizer. */
function goalConcepts(goal: string): Set<string>[] {
  return wordsOf(goal)
    .map((word) => tokenizeGoal(word))
    .filter((concept) => concept.size > 0);
}

function scoreDeclaration(d: { symbol: string; container: string | null }, goalTokens: Set<string>): number {
  const nameTokens = new Set([...wordsOf(d.symbol), ...(d.container ? wordsOf(d.container) : [])]);
  let score = 0;
  for (const token of goalTokens) if (anyRelated(nameTokens, token)) score += 3;
  return score;
}

function conceptsCarried(d: GraphDeclaration, concepts: Set<string>[]): number {
  const nameTokens = new Set([...wordsOf(d.symbol), ...(d.container ? wordsOf(d.container) : [])]);
  return concepts.filter((concept) => [...concept].some((token) => anyRelated(nameTokens, token))).length;
}

function reachableFrom(startKey: string, edgesFrom: ReadonlyMap<string, FlowEdge[]>): Set<string> {
  const seen = new Set<string>();
  let frontier = [startKey];
  for (let depth = 0; depth < MAX_HOPS && frontier.length; depth++) {
    frontier = frontier.flatMap((key) => (edgesFrom.get(key) ?? []).map((edge) => keyOf(edge.to))).filter((key) => !seen.has(key) && seen.add(key));
  }
  return seen;
}

function outermostRelevant(input: SelectionInput, relevant: GraphDeclaration[], concepts: Set<string>[]): CodeSymbol[] {
  const carried = new Map(relevant.map((d) => [d, conceptsCarried(d, concepts)] as const));
  const required = Math.min(2, Math.max(0, ...carried.values()));
  const callable = relevant.filter((d) => input.callable.has(keyOf(d)) && (carried.get(d) ?? 0) >= required);
  const reach = new Map(callable.map((d) => [keyOf(d), reachableFrom(keyOf(d), input.edgesFrom)]));
  return callable.filter((d) => !callable.some((other) => other !== d && reach.get(keyOf(other))!.has(keyOf(d)) && !reach.get(keyOf(d))!.has(keyOf(other)))).map(toSymbol);
}

function shortestPath(entries: readonly CodeSymbol[], targetKey: string, edgesFrom: ReadonlyMap<string, FlowEdge[]>, maxDepth: number): FlowEdge[] | null {
  const visited = new Set(entries.map(keyOf));
  const queue: { key: string; path: FlowEdge[] }[] = entries.map((entry) => ({ key: keyOf(entry), path: [] }));
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    if (current.key === targetKey && current.path.length > 0) return current.path;
    if (current.path.length >= maxDepth) continue;
    for (const edge of edgesFrom.get(current.key) ?? []) {
      const key = keyOf(edge.to);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ key, path: [...current.path, edge] });
    }
  }
  return null;
}

function edgeRelevance(edge: FlowEdge, goalTokens: Set<string>, fromContainer: string | null): number {
  const nameTokens = new Set(wordsOf(edge.to.symbol));
  if (edge.to.container && edge.to.container !== fromContainer) for (const word of wordsOf(edge.to.container)) nameTokens.add(word);
  const args = new Set(wordsOf(edge.argsText));
  let score = 0;
  for (const token of goalTokens) {
    if (anyRelated(nameTokens, token)) score += 3;
    else if (anyRelated(args, token)) score += 2;
  }
  return score;
}

function extendPath(edgesFrom: ReadonlyMap<string, FlowEdge[]>, start: CodeSymbol, goalTokens: Set<string>, alreadyVisited: Iterable<string>, budget: number): FlowEdge[] {
  const path: FlowEdge[] = [];
  const visited = new Set(alreadyVisited);
  let current = start;
  while (path.length < budget) {
    const options = (edgesFrom.get(keyOf(current)) ?? []).filter((edge) => !visited.has(keyOf(edge.to)));
    if (!options.length) break;
    let next: FlowEdge | undefined = options.find((edge) => edge.kind === "implements");
    if (!next) {
      const ranked = options.map((edge) => ({ edge, score: edgeRelevance(edge, goalTokens, current.container) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
      if (ranked.length === 1 || (ranked.length > 1 && ranked[0]!.score > ranked[1]!.score)) next = ranked[0]!.edge;
    }
    if (!next) break;
    path.push(next);
    visited.add(keyOf(next.to));
    current = next.to;
  }
  return path;
}

function externalBoundary(input: SelectionInput, node: CodeSymbol, goalTokens: Set<string>): ExternalCall | null {
  if ((input.edgesFrom.get(keyOf(node)) ?? []).length) return null;
  const scored = (input.externals.get(keyOf(node)) ?? []).map((call) => {
    const names = new Set(call.members.flatMap(wordsOf));
    const args = new Set(wordsOf(call.argsText));
    let score = 0;
    for (const token of goalTokens) score += anyRelated(names, token) ? 3 : anyRelated(args, token) ? 2 : 0;
    return { call, score };
  });
  const ranked = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  return ranked.length === 1 || (ranked.length > 1 && ranked[0]!.score > ranked[1]!.score) ? ranked[0]!.call : null;
}

export type Candidate = { edges: FlowEdge[]; chain: CodeSymbol[]; density: number; hops: number };
export type Ranking = { goalTokens: Set<string>; relevant: GraphDeclaration[]; roots: CodeSymbol[]; candidates: Candidate[] };

/** Everything discoverFlowAst decides from, exposed so a diagnostic can see WHY a chain won or no chain exists. */
export function rankCandidates(goal: string, input: SelectionInput, intent: FlowIntent): Ranking {
  const entries = intent === "trace_request" ? input.entries : [];
  if (intent === "trace_request" && !entries.length) throw new Error("Nenhum ponto de entrada HTTP encontrado.");
  const goalTokens = tokenizeGoal(goal);
  if (!goalTokens.size) throw new Error(`Não foi possível extrair palavras-chave do objetivo "${goal}".`);

  const scoredAll = input.declarations.map((d) => ({ d, score: scoreDeclaration(d, goalTokens) })).filter((entry) => entry.score > 0);
  if (!scoredAll.length) throw new Error(`Nenhum símbolo corresponde ao objetivo "${goal}".`);

  const roots = intent === "trace_request" ? [...entries] : outermostRelevant(input, scoredAll.map((entry) => entry.d), goalConcepts(goal));
  const rootKeys = new Set(roots.map(keyOf));

  const candidates = scoredAll
    .map((entry) => {
      const initial = intent === "other" && rootKeys.has(keyOf(entry.d)) ? [] : shortestPath(roots, keyOf(entry.d), input.edgesFrom, MAX_HOPS);
      if (!initial) return null;
      const anchor = toSymbol(entry.d);
      const visited = [initial.length ? keyOf(initial[0]!.from) : keyOf(anchor), ...initial.map((edge) => keyOf(edge.to))];
      const edges = [...initial, ...extendPath(input.edgesFrom, anchor, goalTokens, visited, MAX_HOPS - initial.length)];
      if (!edges.length) return null;
      const chain = [edges[0]!.from, ...edges.map((edge) => edge.to)];
      const total = chain.reduce((sum, node) => sum + scoreDeclaration(node, goalTokens), 0) + edges.reduce((sum, edge) => sum + edgeRelevance(edge, goalTokens, edge.from.container), 0);
      return { edges, chain, density: total / chain.length, hops: edges.length };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.density - a.density || b.hops - a.hops);

  return { goalTokens, relevant: scoredAll.map((entry) => entry.d), roots, candidates };
}

export function discoverFlowAst(goal: string, input: SelectionInput, intent: FlowIntent): AstFlowPath {
  const { goalTokens, relevant, candidates } = rankCandidates(goal, input, intent);
  const best = candidates[0];
  if (!best) {
    const names = relevant.map((d) => (d.container ? `${d.container}.${d.symbol}` : d.symbol)).join(", ");
    throw new Error(`O objetivo "${goal}" corresponde a ${names}, mas ${intent === "trace_request" ? "nenhum ponto de entrada alcança esse símbolo" : "nenhuma chamada comprovada o conecta a outro símbolo"}.`);
  }
  return { goal, intent, keywords: [...goalTokens], entry: best.edges[0]!.from, target: best.chain.at(-1)!, chain: best.chain, edges: best.edges, external: externalBoundary(input, best.chain.at(-1)!, goalTokens) };
}
