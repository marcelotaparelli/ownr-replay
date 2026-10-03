/**
 * Spike harness (diagnostic, not part of `bun test`): runs the 15-repository benchmark through the CURRENT discovery
 * and through the AST spike (src/experiments), same SHAs, intents and goals, and prints them side by side.
 *
 *   bun scripts/benchmark-ast-spike.ts [--root DIR] [--ablate] [id ...]
 *
 * --root DIR   reuse already-ingested snapshots (DIR/<name>/snapshot.json + original/); otherwise ingest from GitHub.
 * --ablate     also run the AST spike with each structural capability switched off (and with all off).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFlowAst } from "../src/experiments/ast-flow-discovery.ts";
import { buildAstGraph, FULL_AST, INFERRED_AST, type AstGraph, type AstOptions } from "../src/experiments/ast-facts.ts";
import { indexRepository } from "../src/services/code-map.ts";
import { discoverFlow } from "../src/services/flow-discovery.ts";
import { SnapshotIngestor } from "../src/services/repository-ingest.ts";
import { parseGithubRepoUrl } from "../src/services/repo-url.ts";
import { BenchmarkSchema, label, matchesGold, PinnedSource, type BenchmarkRepo } from "./benchmark-flow-discovery.ts";

type Verdict = { gold: boolean; text: string; external: string | null };

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const rootDir = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
const ablate = args.includes("--ablate");
const only = new Set(args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--root"));

const { repos } = BenchmarkSchema.parse(await Bun.file(join(import.meta.dir, "../benchmarks/flow-discovery.json")).json());
const selected = repos.filter((r) => only.size === 0 || only.has(r.id));

/** Directory holding `original/` for the benchmark's pinned commit. */
async function locate(r: BenchmarkRepo, scratch: string): Promise<string | undefined> {
  if (rootDir) {
    const match = readdirSync(rootDir).find((d) => {
      try {
        return JSON.parse(readFileSync(join(rootDir, d, "snapshot.json"), "utf8")).sha === r.sha;
      } catch {
        return false;
      }
    });
    return match ? join(rootDir, match, "original") : undefined;
  }
  const repo = parseGithubRepoUrl(`https://github.com/${r.repo}`);
  if (!repo) return undefined;
  const ingestor = new SnapshotIngestor(scratch, new PinnedSource(new Map([[r.repo.toLowerCase(), r.sha]])), []);
  const { source } = await ingestor.ensure(repo);
  return join(scratch, source.base.id, "original");
}

function current(r: BenchmarkRepo, original: string): Verdict {
  try {
    const flow = discoverFlow(r.goal, indexRepository(original), r.intent);
    return { gold: matchesGold(flow.chain, r.gold), text: flow.chain.map(label).join(" -> "), external: flow.external ? flow.external.members.join(".") : null };
  } catch (error) {
    return { gold: false, text: `ERROR ${(error as Error).message.slice(0, 70)}`, external: null };
  }
}

function ast(r: BenchmarkRepo, graph: AstGraph): Verdict {
  try {
    const flow = discoverFlowAst(r.goal, graph, r.intent);
    return { gold: matchesGold(flow.chain, r.gold), text: flow.chain.map(label).join(" -> "), external: flow.external ? `${flow.external.receiver.join(".")}→${flow.external.members.join(".")} (${flow.external.module})` : null };
  } catch (error) {
    return { gold: false, text: `ERROR ${(error as Error).message.slice(0, 70)}`, external: null };
  }
}

const scratch = mkdtempSync(join(tmpdir(), "ast-spike-bench-"));
try {
  const located = new Map<string, string>();
  for (const r of selected) {
    try {
      const dir = await locate(r, join(scratch, r.id));
      if (dir) located.set(r.id, dir);
      else console.log(`${r.id} SKIP (no snapshot)`);
    } catch (error) {
      console.log(`${r.id} SKIP (ingestion failed: ${(error as Error).message.slice(0, 60)})`);
    }
  }

  let currentHits = 0;
  let astHits = 0;
  let inferredHits = 0;
  for (const r of selected) {
    const dir = located.get(r.id);
    if (!dir) continue;
    const c0 = performance.now();
    const before = current(r, dir);
    const currentMs = Math.round(performance.now() - c0);
    const t0 = performance.now();
    const graph = await buildAstGraph(dir, FULL_AST);
    const after = ast(r, graph);
    const inferred = ast(r, await buildAstGraph(dir, INFERRED_AST));
    inferredHits += inferred.gold ? 1 : 0;
    currentHits += before.gold ? 1 : 0;
    astHits += after.gold ? 1 : 0;
    console.log(`\n${r.id} ${r.repo} [${r.intent}]  ${r.goal}`);
    console.log(`  expected: ${r.gold.join("  →  ")}`);
    console.log(`  current : ${before.gold ? "GOLD" : "miss"}  ${before.text}${before.external ? `  [ext ${before.external}]` : ""}`);
    console.log(`  ast     : ${after.gold ? "GOLD" : "miss"}  ${after.text}${after.external ? `  [ext ${after.external}]` : ""}`);
    if (inferred.text !== after.text) console.log(`  ast+inf : ${inferred.gold ? "GOLD" : "miss"}  ${inferred.text}${inferred.external ? `  [ext ${inferred.external}]` : ""}`);
    console.log(`  cost    : parse ${graph.stats.parseMs} ms, build ${graph.stats.buildMs} ms, total ${Math.round(performance.now() - t0)} ms; ${graph.stats.files} files, ${graph.stats.declarations} decls, ${graph.stats.edges} edges, ${graph.stats.externalCalls} external calls (current discovery: ${currentMs} ms), ${graph.stats.aliasResolved.length} alias imports resolved`);
  }
  console.log(`\ngold-chain matches  current ${currentHits}/${selected.length}   ast ${astHits}/${selected.length}   ast+return-type inference ${inferredHits}/${selected.length}   (gold match is necessary, not sufficient: read the chains)`);

  if (ablate) {
    const keys = (Object.keys(FULL_AST) as (keyof AstOptions)[]).filter((k) => k !== "inferReturns");
    const configs: [string, AstOptions][] = [["full", FULL_AST], ...keys.map((k): [string, AstOptions] => [`without ${k}`, { ...FULL_AST, [k]: false }]), ["core only (all off)", Object.fromEntries(keys.map((k) => [k, false])) as AstOptions]];
    for (const [name, options] of configs) {
      const hits: string[] = [];
      for (const r of selected) {
        const dir = located.get(r.id);
        if (dir && ast(r, await buildAstGraph(dir, options)).gold) hits.push(r.id);
      }
      console.log(`${name.padEnd(24)} ${hits.length}/${selected.length}  ${hits.join(" ")}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
