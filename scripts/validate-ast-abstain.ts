/**
 * Validation of the FROZEN abstention rule (src/experiments/ast-abstain.ts) on a pre-registered holdout. Diagnostic, not product.
 *
 *   bun scripts/validate-ast-abstain.ts --prereg FILE --frozen-state FILE --root DIR [--root DIR ...] [--labels FILE]
 *
 * For every request: does the AST spike produce a chain? its winner / runner-up density and ratio, the share of related nodes, the
 * decision. Gold is used ONLY to give a first-pass label; the human label (labels file) overrides it and is what the metrics use.
 * The frozen modules are hashed and compared with the freeze record: a mismatch aborts the run.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAstGraph, FULL_AST, keyOf } from "../src/experiments/ast-facts.ts";
import { chainSignals } from "../src/experiments/ast-confidence.ts";
import { decide } from "../src/experiments/ast-abstain.ts";
import { discoverFlowAst, rankCandidates } from "../src/experiments/ast-flow-discovery.ts";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const roots = args.flatMap((a, i) => (a === "--root" ? [args[i + 1]!] : []));
const base = join(import.meta.dir, "..");

// ---- the frozen modules must be exactly the recorded ones ----------------------------------------------------------
const FROZEN = ["src/experiments/ast-abstain.ts", "src/experiments/ast-confidence.ts", "src/experiments/ast-facts.ts", "src/experiments/ast-flow-discovery.ts"];
const freeze = readFileSync(opt("--frozen-state")!, "utf8");
for (const file of FROZEN) {
  const now = createHash("sha256").update(readFileSync(join(base, file))).digest("hex");
  const recorded = new RegExp(`([0-9a-f]{64})\\s+${file.replace(/[./]/g, "\\$&")}`).exec(freeze)?.[1];
  if (now !== recorded) throw new Error(`${file} changed since the freeze (${now.slice(0, 12)} != ${recorded?.slice(0, 12)})`);
}
console.log("frozen modules verified:", FROZEN.map((f) => f.split("/").pop()).join(", "));

type Case = { id: string; repo: string; sha: string; intent: "other" | "trace_request"; goal: string; gold: string[]; humanGold: string };
const cases = JSON.parse(readFileSync(opt("--prereg")!, "utf8")).repos as Case[];
const humanLabels: Record<string, string> = opt("--labels") ? JSON.parse(readFileSync(opt("--labels")!, "utf8")).labels : {};

function locate(sha: string): string | undefined {
  for (const root of roots) {
    const hit = readdirSync(root).find((d) => {
      try {
        return JSON.parse(readFileSync(join(root, d, "snapshot.json"), "utf8")).sha === sha;
      } catch {
        return false;
      }
    });
    if (hit) return join(root, hit, "original");
  }
  return undefined;
}
const lab = (s: { container: string | null; symbol: string }): string => (s.container ? `${s.container}.` : "") + s.symbol;
const goldHit = (chain: { path: string; container: string | null; symbol: string }[], gold: string[]): boolean => {
  let n = 0;
  for (const s of chain) if (n < gold.length && new RegExp(gold[n]!).test(`${s.path}#${lab(s)}`)) n++;
  return n === gold.length;
};

type Result = { id: string; produced: boolean; decision: "ACCEPT" | "ABSTAIN"; label: string; winner: number; runnerUp: number; ratio: number; related: number; goldMatch: boolean; chain: string; why: string; ms: number };
const results: Result[] = [];
for (const c of cases) {
  const dir = locate(c.sha);
  if (!dir) { console.log(`${c.id} SKIP: no snapshot`); continue; }
  const t0 = performance.now();
  const graph = await buildAstGraph(dir, FULL_AST);
  const signals = chainSignals(c.goal, c.intent, graph);
  const decision = decide(signals);
  let winner = 0, runnerUp = 0, chain = "(no chain)", goldMatch = false;
  if (signals) {
    const flow = discoverFlowAst(c.goal, graph, c.intent);
    chain = flow.chain.map(lab).join(" -> ") + (flow.external ? `  [ext ${flow.external.members.join(".")}]` : "");
    goldMatch = goldHit(flow.chain, c.gold);
    const densities = [...new Map(rankCandidates(c.goal, graph, c.intent).candidates.map((k) => [k.chain.map(keyOf).join(">"), k.density])).values()].sort((a, b) => b - a);
    winner = densities[0] ?? 0; runnerUp = densities[1] ?? 0;
  }
  const label = humanLabels[c.id] ?? (signals ? (goldMatch ? "correct?" : "wrong?") : "no-chain");
  results.push({ id: c.id, produced: signals !== null, decision: decision.verdict, label, winner, runnerUp, ratio: signals?.runnerUpRatio ?? 0, related: signals?.nodesRelatedShare ?? 0, goldMatch, chain, why: decision.reasons.join("; "), ms: performance.now() - t0 });
}

console.log("\nid    produced  winner  runner  ratio  related  decision  label       gold  chain");
for (const r of results) console.log(`${r.id.padEnd(5)} ${(r.produced ? "chain" : "none").padEnd(9)} ${r.winner.toFixed(2).padStart(6)} ${r.runnerUp.toFixed(2).padStart(7)} ${r.ratio.toFixed(2).padStart(6)} ${(r.related * 100).toFixed(0).padStart(6)}%  ${r.decision.padEnd(8)}  ${r.label.padEnd(10)}  ${r.goldMatch ? "Y" : "-"}     ${r.chain.slice(0, 110)}${r.why ? `   <${r.why}>` : ""}`);

// ---- metrics ------------------------------------------------------------------------------------------------------------
const isCorrect = (r: Result): boolean => r.label === "correct";
const accepted = results.filter((r) => r.decision === "ACCEPT");
const tp = accepted.filter(isCorrect).length;
const fp = accepted.length - tp;
const fn = results.filter((r) => r.decision === "ABSTAIN" && isCorrect(r)).length;
const produced = results.filter((r) => r.produced);
const correctTotal = results.filter(isCorrect).length;

/** Exact (Clopper-Pearson) two-sided interval, by bisection on the binomial tails. */
function logChoose(n: number, k: number): number { let s = 0; for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i); return s; }
function binomTail(n: number, k: number, p: number, upper: boolean): number { // P(X>=k) if upper else P(X<=k)
  const pmf = (i: number): number => (p === 0 ? (i === 0 ? 1 : 0) : p === 1 ? (i === n ? 1 : 0) : Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p)));
  let s = 0; for (let i = upper ? k : 0; i <= (upper ? n : k); i++) s += pmf(i); return s;
}
function clopperPearson(k: number, n: number, alpha = 0.05): [number, number] {
  const solve = (f: (p: number) => number, target: number, increasing: boolean): number => { let lo = 0, hi = 1; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; ((f(mid) < target) === increasing ? (lo = mid) : (hi = mid)); } return (lo + hi) / 2; };
  const lower = k === 0 ? 0 : solve((p) => binomTail(n, k, p, true), alpha / 2, true);
  const upper = k === n ? 1 : solve((p) => binomTail(n, k, p, false), alpha / 2, false);
  return [lower, upper];
}
const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;
const ci = (k: number, n: number): string => (n === 0 ? "n/a" : `${pct(k / n)} (95% exact CI ${pct(clopperPearson(k, n)[0])}..${pct(clopperPearson(k, n)[1])})`);

console.log(`\nrequests ${results.length}; AST produced a chain for ${produced.length}; no chain ${results.length - produced.length}`);
console.log(`human labels among produced chains: correct ${produced.filter(isCorrect).length}, wrong ${produced.filter((r) => r.label === "wrong").length}, incomplete ${produced.filter((r) => r.label === "incomplete").length}, unlabelled ${produced.filter((r) => r.label.endsWith("?")).length}`);
console.log(`\nB. frozen rule : ACCEPT ${accepted.length}, ABSTAIN ${results.length - accepted.length}; TP ${tp}, FP ${fp}, FN ${fn}`);
console.log(`   precision of accepted ${accepted.length ? ci(tp, accepted.length) : "n/a (nothing accepted)"}`);
console.log(`   coverage ${accepted.length}/${results.length} = ${pct(accepted.length / results.length)}   recall of correct chains ${tp}/${correctTotal}`);
console.log(`A. accept every chain: ${produced.length} accepted; precision ${produced.length ? ci(produced.filter(isCorrect).length, produced.length) : "n/a"}; coverage ${produced.length}/${results.length}`);
for (const r of accepted.filter((x) => !isCorrect(x))) console.log(`!! FALSE POSITIVE ${r.id}: ${r.label} chain accepted -> ${r.chain}`);
console.log(`time: ${(results.reduce((s, r) => s + r.ms, 0) / results.length).toFixed(0)} ms/request`);
