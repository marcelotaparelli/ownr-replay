/**
 * Diagnostic harness (not part of `bun test`: it needs the network): replays benchmarks/flow-discovery.json
 * against the pinned commits and prints, per repository, what discovery returns and whether it matches the
 * recorded `gold` chain. It reads product code and changes none of it.
 *
 *   bun scripts/benchmark-flow-discovery.ts [id ...]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discoverFlow } from "../src/services/flow-discovery.ts";
import { GithubHttpSource, SnapshotIngestor, type RepoHead } from "../src/services/repository-ingest.ts";
import { parseGithubRepoUrl, type GithubRepo } from "../src/services/repo-url.ts";

export const BenchmarkSchema = z.object({
  repos: z.array(
    z.object({
      id: z.string(),
      repo: z.string(),
      sha: z.string().regex(/^[0-9a-f]{40}$/),
      shape: z.string(),
      intent: z.enum(["other", "trace_request"]),
      goal: z.string(),
      gold: z.array(z.string()),
      outcome: z.enum(["success", "no_flow", "wrong_flow"]),
      flow: z.string().optional(),
      firstCause: z.string().optional(),
      walls: z.array(z.string()).optional(),
    }),
  ),
});
export type BenchmarkRepo = z.infer<typeof BenchmarkSchema>["repos"][number];

/** The ingestor always asks for the default branch's head; the benchmark must read the recorded commit. */
class PinnedSource extends GithubHttpSource {
  constructor(private readonly pins: ReadonlyMap<string, string>) {
    super();
  }
  override async head(repo: GithubRepo, signal: AbortSignal): Promise<RepoHead> {
    const sha = this.pins.get(`${repo.owner}/${repo.name}`.toLowerCase());
    if (!sha) throw new Error(`no pinned sha for ${repo.owner}/${repo.name}`);
    return { branch: "pinned", sha };
  }
}

export const label = (node: { container: string | null; symbol: string }): string => (node.container ? `${node.container}.${node.symbol}` : node.symbol);

/** True when the chain contains every `gold` pattern in order (patterns match `path#Container.symbol`). */
export function matchesGold(chain: readonly { path: string; container: string | null; symbol: string }[], gold: readonly string[]): boolean {
  let next = 0;
  for (const node of chain) if (next < gold.length && new RegExp(gold[next]!).test(`${node.path}#${label(node)}`)) next++;
  return next === gold.length;
}

if (import.meta.main) {
  const { repos } = BenchmarkSchema.parse(await Bun.file(join(import.meta.dir, "../benchmarks/flow-discovery.json")).json());
  const only = new Set(process.argv.slice(2));
  const selected = repos.filter((r) => only.size === 0 || only.has(r.id));
  const root = mkdtempSync(join(tmpdir(), "flow-benchmark-"));
  try {
    const pins = new Map(selected.map((r) => [r.repo.toLowerCase(), r.sha] as const));
    const ingestor = new SnapshotIngestor(root, new PinnedSource(pins), []);
    for (const r of selected) {
      const repo = parseGithubRepoUrl(`https://github.com/${r.repo}`);
      if (!repo) throw new Error(`bad repo ${r.repo}`);
      let index;
      try {
        index = (await ingestor.ensure(repo)).source.index;
      } catch (error) {
        console.log(`${r.id.padEnd(4)} SKIP ${r.repo} (ingestion failed: ${(error as Error).message.slice(0, 80)})`);
        continue;
      }
      let actual: string;
      let hit = false;
      try {
        const flow = discoverFlow(r.goal, index, r.intent);
        hit = matchesGold(flow.chain, r.gold);
        actual = flow.chain.map(label).join(" -> ");
      } catch (error) {
        actual = `ERROR: ${(error as Error).message.slice(0, 100)}`;
      }
      const verdict = hit ? "GOLD" : "MISS";
      const drift = (r.outcome === "success") !== hit ? "  <-- differs from the recorded outcome" : "";
      console.log(`${r.id.padEnd(4)} ${verdict} ${r.repo} [${r.intent}] ${actual}${drift}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
