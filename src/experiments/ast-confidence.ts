import type { CodeSymbol, FlowEdge, FlowIntent } from "../services/flow-discovery.ts";
import { tokenizeGoal, wordsOf } from "../services/flow-discovery.ts";
import { keyOf, type AstGraph } from "./ast-facts.ts";
import { discoverFlowAst, rankCandidates, type Candidate } from "./ast-flow-discovery.ts";

/**
 * EXPERIMENT (not product, nothing imports it): observable signals about ONE chain the AST spike produced, computed from
 * the goal, the graph and the ranking only. The gold chain is never an input; labels live outside this file. The relevance
 * helpers (5-letter prefix rule, edge relevance) are copies of the product's private ones so that "relevant" means exactly
 * what the selector meant.
 */

export type TerminalKind = "external" | "contract" | "leaf" | "stopped";

export type ChainSignals = {
  // size and shape
  hops: number;
  implementsEdges: number;
  // goal coverage by the chain's own names
  concepts: number;
  conceptsCovered: number;
  conceptCoverage: number;
  /** Concepts that are NOT generic persistence/creation verbs (the glossary's `create`, `save`, ... expansions). */
  domainConcepts: number;
  domainConceptsCovered: number;
  /** Covered concepts matched only through the 5-letter prefix rule (no identical word). */
  prefixOnlyMatches: number;
  nodesRelatedShare: number;
  entryRelated: boolean;
  targetRelated: boolean;
  /** Share of edges whose callee NAME (score 3) matches the goal; args-only (score 2) and none are the rest. */
  edgesByNameShare: number;
  edgesWithoutEvidenceShare: number;
  // ranking landscape
  distinctCandidates: number;
  tiedWithTop: number;
  nearTop: number;
  marginToNext: number;
  /** Density of the runner-up chain over the winner's (1 = a tie, 0 = no other chain). */
  runnerUpRatio: number;
  roots: number;
  relevantDeclarations: number;
  // where the chain stops
  terminal: TerminalKind;
  terminalOutDegree: number;
  /** Outgoing edges of the last node that are goal-relevant but were not followed (the walk stopped at a fork). */
  terminalForkWidth: number;
  // how generic the endpoints are in this repository
  targetNameFrequency: number;
  entryNameFrequency: number;
  // dependence on heuristics
  usesEntryHeuristic: boolean;
  aliasEdges: number;
};

const related = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 5;
};

/** The product's glossary expands "persistida", "criada"... into these; a concept containing one is about the VERB, not the domain. */
const GENERIC_VERBS = new Set(["create", "save", "persist", "persistence", "store", "write", "complete", "repository"]);

const wordsOfNode = (n: { symbol: string; container: string | null }): Set<string> => new Set([...wordsOf(n.symbol), ...(n.container ? wordsOf(n.container) : [])]);

function edgeScore(edge: FlowEdge, goalTokens: Set<string>, fromContainer: string | null): number {
  const names = new Set(wordsOf(edge.to.symbol));
  if (edge.to.container && edge.to.container !== fromContainer) for (const w of wordsOf(edge.to.container)) names.add(w);
  const args = new Set(wordsOf(edge.argsText));
  let score = 0;
  for (const token of goalTokens) {
    if ([...names].some((w) => related(w, token))) score += 3;
    else if ([...args].some((w) => related(w, token))) score += 2;
  }
  return score;
}

const share = (hits: number, total: number): number => (total === 0 ? 0 : hits / total);

/** Null when the spike produces no chain at all (that case already abstains by itself). */
export function chainSignals(goal: string, intent: FlowIntent, graph: AstGraph): ChainSignals | null {
  let best: ReturnType<typeof discoverFlowAst>;
  let ranking: ReturnType<typeof rankCandidates>;
  try {
    best = discoverFlowAst(goal, graph, intent);
    ranking = rankCandidates(goal, graph, intent);
  } catch {
    return null;
  }
  const { goalTokens } = ranking;
  const concepts = wordsOf(goal).map((word) => tokenizeGoal(word)).filter((c) => c.size > 0);
  const chain = best.chain;
  const nodeWords = chain.map(wordsOfNode);
  const covered = concepts.filter((c) => nodeWords.some((words) => [...c].some((token) => [...words].some((w) => related(w, token)))));
  const isDomain = (c: Set<string>): boolean => ![...c].some((t) => GENERIC_VERBS.has(t));
  const prefixOnly = covered.filter((c) => !nodeWords.some((words) => [...c].some((token) => words.has(token)))).length;
  const nodeScore = (n: CodeSymbol): number => [...goalTokens].filter((t) => [...wordsOfNode(n)].some((w) => related(w, t))).length;

  // distinct chains: the ranking lists the same chain once per anchor that reaches it
  const byChain = new Map<string, Candidate>();
  for (const c of ranking.candidates) if (!byChain.has(c.chain.map(keyOf).join(">"))) byChain.set(c.chain.map(keyOf).join(">"), c);
  const densities = [...byChain.values()].map((c) => c.density).sort((a, b) => b - a);
  const top = densities[0] ?? 0;
  const next = densities.find((d) => d < top - 1e-9);

  const last = chain.at(-1)!;
  const out = graph.edgesFrom.get(keyOf(last)) ?? [];
  const visited = new Set(chain.map(keyOf));
  const forkWidth = out.filter((e) => !visited.has(keyOf(e.to)) && edgeScore(e, goalTokens, last.container) > 0).length;
  const terminal: TerminalKind = best.external ? "external" : !graph.callable.has(keyOf(last)) ? "contract" : out.length === 0 ? "leaf" : "stopped";

  const edgeScores = best.edges.map((e) => edgeScore(e, goalTokens, e.from.container));
  const byName = best.edges.filter((e) => [...wordsOfNode(e.to)].some((w) => [...goalTokens].some((t) => related(w, t)))).length;
  const freq = (n: CodeSymbol): number => graph.declarations.filter((d) => d.symbol === n.symbol).length - 1;
  const aliasPairs = graph.stats.aliasResolved.map((a) => {
    const [fromPath, rest] = a.split(" :: ");
    return `${fromPath}>${rest?.split(" -> ")[1]}`;
  });

  return {
    hops: best.edges.length,
    implementsEdges: best.edges.filter((e) => e.kind === "implements").length,
    concepts: concepts.length,
    conceptsCovered: covered.length,
    conceptCoverage: share(covered.length, concepts.length),
    domainConcepts: concepts.filter(isDomain).length,
    domainConceptsCovered: covered.filter(isDomain).length,
    prefixOnlyMatches: prefixOnly,
    nodesRelatedShare: share(chain.filter((n) => nodeScore(n) > 0).length, chain.length),
    entryRelated: nodeScore(chain[0]!) > 0,
    targetRelated: nodeScore(last) > 0,
    edgesByNameShare: share(byName, best.edges.length),
    edgesWithoutEvidenceShare: share(edgeScores.filter((s) => s === 0).length, best.edges.length),
    distinctCandidates: byChain.size,
    tiedWithTop: densities.filter((d) => Math.abs(d - top) < 1e-9).length,
    nearTop: densities.filter((d) => d >= top * 0.9 - 1e-9).length,
    marginToNext: next === undefined ? top : top - next,
    runnerUpRatio: densities.length > 1 && top > 0 ? densities[1]! / top : 0,
    roots: ranking.roots.length,
    relevantDeclarations: ranking.relevant.length,
    terminal,
    terminalOutDegree: out.length,
    terminalForkWidth: forkWidth,
    targetNameFrequency: freq(last),
    entryNameFrequency: freq(chain[0]!),
    usesEntryHeuristic: intent === "trace_request",
    aliasEdges: best.edges.filter((e) => aliasPairs.includes(`${e.from.path}>${e.to.path}`)).length,
  };
}
