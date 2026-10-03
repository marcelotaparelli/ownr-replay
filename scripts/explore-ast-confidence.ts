/**
 * Exploration (not product): do signals observable on the AST spike's chain separate correct answers from wrong or
 * incomplete ones? Phase 1 prints the signal table and per-signal separation; it then searches single and paired
 * threshold rules, checks them leave-one-out, and asks how often a label-shuffled dataset would look as separable.
 *
 *   bun scripts/explore-ast-confidence.ts --root DIR [--root DIR ...]   (dirs holding <snapshot>/snapshot.json + original/)
 *
 * The 25 cases were already used to build and debug the spike: nothing here is evidence of generalisation.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAstGraph, FULL_AST } from "../src/experiments/ast-facts.ts";
import { chainSignals, type ChainSignals } from "../src/experiments/ast-confidence.ts";
import { BenchmarkSchema } from "./benchmark-flow-discovery.ts";

type Label = "correct" | "wrong" | "incomplete" | "no-chain";
type Row = { id: string; label: Label; signals: ChainSignals | null };

const args = process.argv.slice(2);
const roots = args.flatMap((a, i) => (a === "--root" ? [args[i + 1]!] : []));
const base = join(import.meta.dir, "..");
const calibration = BenchmarkSchema.parse(JSON.parse(readFileSync(join(base, "benchmarks/flow-discovery.json"), "utf8"))).repos;
const holdout = JSON.parse(readFileSync(join(base, "benchmarks/holdout/PREREGISTRATION.json"), "utf8")).repos as { id: string; repo: string; sha: string; intent: "other" | "trace_request"; goal: string }[];
const labels = JSON.parse(readFileSync(join(base, "benchmarks/confidence/labels.json"), "utf8")).labels as Record<string, Label>;

function locate(sha: string): string {
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
  throw new Error(`no snapshot for ${sha}; pass --root`);
}

const rows: Row[] = [];
for (const r of [...calibration, ...holdout]) {
  const graph = await buildAstGraph(locate(r.sha), FULL_AST);
  rows.push({ id: r.id, label: labels[r.id]!, signals: chainSignals(r.goal, r.intent, graph) });
}
writeFileSync(join(base, "benchmarks/confidence/signals.json"), JSON.stringify(rows, null, 1));

const chains = rows.filter((r): r is Row & { signals: ChainSignals } => r.signals !== null);
const isGood = (r: Row): boolean => r.label === "correct";
console.log(`requests ${rows.length}; AST produced a chain for ${chains.length} (${chains.filter(isGood).length} correct, ${chains.filter((r) => r.label === "wrong").length} wrong, ${chains.filter((r) => r.label === "incomplete").length} incomplete); no chain: ${rows.filter((r) => !r.signals).map((r) => r.id).join(" ")}`);
console.log(`accept-everything baseline: precision ${chains.filter(isGood).length}/${chains.length}, coverage ${chains.length}/${rows.length}\n`);

// ---- table ---------------------------------------------------------------------------------------------------------
const keys = Object.keys(chains[0]!.signals) as (keyof ChainSignals)[];
const num = (v: ChainSignals[keyof ChainSignals]): number => (typeof v === "boolean" ? Number(v) : typeof v === "number" ? v : NaN);
const fmt = (v: ChainSignals[keyof ChainSignals]): string => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : typeof v === "boolean" ? (v ? "Y" : "n") : String(v));
console.log("case  label       " + keys.map((k) => k.slice(0, 9).padEnd(9)).join(" "));
for (const r of [...chains].sort((a, b) => a.label.localeCompare(b.label))) console.log(`${r.id.padEnd(5)} ${r.label.padEnd(11)} ` + keys.map((k) => fmt(r.signals[k]).padEnd(9)).join(" "));

// ---- per-signal separation --------------------------------------------------------------------------------------
console.log("\nper signal: values among correct / not-correct (min..max), and the best single threshold (accepted correct/wrong)");
type Rule = { key: keyof ChainSignals; op: ">=" | "<="; t: number };
const test = (s: ChainSignals, r: Rule): boolean => (r.op === ">=" ? num(s[r.key]) >= r.t : num(s[r.key]) <= r.t);
const rulesFor = (key: keyof ChainSignals): Rule[] => {
  const values = [...new Set(chains.map((c) => c.signals[key]).map(num))].sort((a, b) => a - b);
  const cuts = values.length === 1 ? [] : values.slice(1).map((v, i) => (v + values[i]!) / 2);
  return cuts.flatMap((t) => [{ key, op: ">=" as const, t }, { key, op: "<=" as const, t }]);
};
const allSingles = keys.flatMap(rulesFor);
for (const key of keys) {
  const good = chains.filter(isGood).map((c) => num(c.signals[key])); const bad = chains.filter((c) => !isGood(c)).map((c) => num(c.signals[key]));
  const range = (xs: number[]): string => `${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)}`;
  const scored = rulesFor(key).map((r) => { const acc = chains.filter((c) => test(c.signals, r)); return { r, ok: acc.filter(isGood).length, bad: acc.length - acc.filter(isGood).length }; }).filter((x) => x.bad === 0 && x.ok > 0).sort((a, b) => b.ok - a.ok)[0];
  console.log(`  ${String(key).padEnd(24)} correct ${range(good).padEnd(12)} other ${range(bad).padEnd(12)} ${scored ? `pure rule ${scored.r.op}${scored.r.t.toFixed(2)} keeps ${scored.ok}/${good.length} correct, 0 wrong` : "no pure rule"}`);
}

// ---- rule search on bitmasks -----------------------------------------------------------------------------------
const n = chains.length;
const correctMask = chains.reduce((m, c, i) => (isGood(c) ? m | (1 << i) : m), 0);
const maskOf = (r: Rule): number => chains.reduce((m, c, i) => (test(c.signals, r) ? m | (1 << i) : m), 0);
const pop = (m: number): number => { let c = 0; while (m) { c += m & 1; m >>>= 1; } return c; };
type Cand = { rules: Rule[]; mask: number };
const uniq = new Map<number, Cand>();
for (const r of allSingles) { const m = maskOf(r); if (m && !uniq.has(m)) uniq.set(m, { rules: [r], mask: m }); }
const singles = [...uniq.values()];
const pairs: Cand[] = [];
for (let i = 0; i < singles.length; i++) for (let j = i + 1; j < singles.length; j++) { const m = singles[i]!.mask & singles[j]!.mask; if (m && !uniq.has(m)) pairs.push({ rules: [...singles[i]!.rules, ...singles[j]!.rules], mask: m }); }
const pool = [...singles, ...pairs];
const describe = (c: Cand): string => c.rules.map((r) => `${String(r.key)} ${r.op} ${r.t.toFixed(2)}`).join("  AND  ");
const quality = (mask: number, good: number): { acc: number; ok: number; wrong: number } => ({ acc: pop(mask), ok: pop(mask & good), wrong: pop(mask & ~good) });
function bestOf(cands: Cand[], good: number, mask: number): Cand | undefined {
  // zero-wrong rules first (most correct accepted, simplest), else highest precision then size
  const scored = cands.map((c) => { const q = quality(c.mask & mask, good & mask); return { c, q }; }).filter((x) => x.q.acc > 0);
  scored.sort((a, b) => (a.q.wrong === 0 ? 0 : 1) - (b.q.wrong === 0 ? 0 : 1) || (a.q.wrong === 0 ? b.q.ok - a.q.ok : b.q.ok / b.q.acc - a.q.ok / a.q.acc || b.q.ok - a.q.ok) || a.c.rules.length - b.c.rules.length);
  return scored[0]?.c;
}
console.log(`\nrule pool: ${singles.length} distinct single-threshold rules, ${pairs.length} distinct pairs (over ${keys.length} signals)`);
const pure = (cs: Cand[]) => cs.map((c) => ({ c, q: quality(c.mask, correctMask) })).filter((x) => x.q.wrong === 0 && x.q.ok > 0).sort((a, b) => b.q.ok - a.q.ok || a.c.rules.length - b.c.rules.length);
for (const [name, cs] of [["single", singles], ["pair", pairs]] as const) {
  const top = pure(cs).slice(0, 4);
  console.log(`best ZERO-WRONG ${name} rules (of ${chains.filter(isGood).length} correct):`);
  for (const x of top) console.log(`   keeps ${x.q.ok}  (coverage ${x.q.ok}/${rows.length}=${Math.round((100 * x.q.ok) / rows.length)}%)  ${describe(x.c)}`);
  if (!top.length) console.log("   none");
}

// ---- leave-one-out ------------------------------------------------------------------------------------------------
let accepted = 0, acceptedGood = 0; const loo: string[] = [];
for (let i = 0; i < n; i++) {
  const train = ((1 << n) - 1) & ~(1 << i);
  const rule = bestOf(pool, correctMask, train);
  const takes = rule ? (rule.mask >> i) & 1 : 0;
  if (takes) { accepted++; if (isGood(chains[i]!)) acceptedGood++; }
  loo.push(`${chains[i]!.id}:${takes ? (isGood(chains[i]!) ? "ACCEPT ok" : "ACCEPT WRONG") : "abstain"}`);
}
console.log(`\nleave-one-out (rule re-learned without the case): accepted ${accepted}, of which correct ${acceptedGood}  -> precision ${accepted ? Math.round((100 * acceptedGood) / accepted) : "-"}%, coverage ${accepted}/${rows.length}`);
console.log("  " + loo.join("  "));

// ---- permutation test -----------------------------------------------------------------------------------------------
const observed = pure(pool)[0]?.q.ok ?? 0;
const shuffles = 2000; let atLeast = 0; const goodCount = pop(correctMask);
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
for (let s = 0; s < shuffles; s++) {
  const idx = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
  const shuffled = idx.slice(0, goodCount).reduce((m, i) => m | (1 << i), 0);
  let best = 0; for (const c of pool) { if (c.mask & ~shuffled) continue; const k = pop(c.mask); if (k > best) best = k; }
  if (best >= observed) atLeast++;
}
console.log(`\npermutation test: best zero-wrong rule keeps ${observed} correct; with labels shuffled the same search keeps >= ${observed} in ${atLeast}/${shuffles} shuffles (p ~ ${(atLeast / shuffles).toFixed(3)})`);

// ======================================================================================================================
// Phase 2: the isolated selector (accept or abstain on the ONE chain the spike produced; never another chain)
// ======================================================================================================================
import { decide } from "../src/experiments/ast-abstain.ts";

console.log("\n=== runner-up / winner density per case (1.00 = tie) ===");
for (const group of ["correct", "wrong", "incomplete"] as const) console.log(`  ${group.padEnd(10)} ` + chains.filter((c) => c.label === group).map((c) => `${c.id}:${c.signals.runnerUpRatio.toFixed(2)}`).join("  "));

type Evaluate = { name: string; accept: (s: ChainSignals | null) => boolean };
function evaluate({ name, accept }: Evaluate): void {
  const acc = rows.filter((r) => accept(r.signals));
  const ok = acc.filter((r) => r.label === "correct").length;
  const wrong = acc.filter((r) => r.label === "wrong").length;
  const incomplete = acc.filter((r) => r.label === "incomplete").length;
  const correctTotal = rows.filter((r) => r.label === "correct").length;
  const wrongTotal = rows.filter((r) => r.label === "wrong").length;
  const incompleteTotal = rows.filter((r) => r.label === "incomplete").length;
  console.log(`${name.padEnd(46)} accepted ${String(acc.length).padStart(2)}  precision ${acc.length ? `${ok}/${acc.length}=${Math.round((100 * ok) / acc.length)}%` : "n/a"}  coverage ${acc.length}/${rows.length}=${Math.round((100 * acc.length) / rows.length)}%  keeps ${ok}/${correctTotal} correct  blocks ${wrongTotal - wrong}/${wrongTotal} wrong, ${incompleteTotal - incomplete}/${incompleteTotal} incomplete`);
}
console.log("\n=== selectors on the 25 exploratory cases (post hoc: NOT evidence of generalisation) ===");
evaluate({ name: "accept every chain (baseline)", accept: (s) => s !== null });
evaluate({ name: "decide(): no close competitor AND all nodes related", accept: (s) => decide(s).verdict === "ACCEPT" });
evaluate({ name: "  only: no close competitor", accept: (s) => s !== null && s.runnerUpRatio < 0.9 });
evaluate({ name: "  only: all nodes related", accept: (s) => s !== null && s.nodesRelatedShare === 1 });
evaluate({ name: "  only: strict winner (no tie)", accept: (s) => s !== null && s.tiedWithTop === 1 });
evaluate({ name: "  tie-free AND all nodes related", accept: (s) => s !== null && s.tiedWithTop === 1 && s.nodesRelatedShare === 1 });

console.log("\n=== sensitivity of decide() to the 'close competitor' band (accept iff runner-up/winner < band AND all nodes related) ===");
for (const band of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0]) evaluate({ name: `  band ${band.toFixed(2)}`, accept: (s) => s !== null && s.runnerUpRatio < band && s.nodesRelatedShare === 1 });

console.log("\n=== decide() per case ===");
for (const r of rows) {
  const d = decide(r.signals);
  console.log(`${r.id.padEnd(4)} ${r.label.padEnd(10)} ${d.verdict.padEnd(7)} ${d.reasons.join("; ")}`);
}
