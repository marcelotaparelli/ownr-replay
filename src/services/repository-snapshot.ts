import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Journey } from "../domain/journey.ts";
import { FROM_SCRATCH } from "../domain/learning-goal.ts";
import { indexRepository, originalDir, type RepositoryIndex } from "./code-map.ts";

/**
 * A repository pinned at one SHA whose journeys are GENERATED from its code (flow discovery), not
 * hand-authored — the second kind of source next to data/golden. Layout per repository:
 *   snapshot.json                  owner, name, url and the pinned sha
 *   original/<repo path>           the .ts sources copied from the real repository at that sha
 * Serving from a pinned copy keeps generation deterministic and free of any fetch at generation
 * time; every reference a journey makes points at that exact sha. Snapshots are either committed
 * by hand (the original two) or written by services/repository-ingest.ts, which adds the id, the
 * branch, the fetch time and the list of files kept.
 */

export type RepositorySource = {
  /** An empty journey carrying only the repository identity: generated routes are derived from it. */
  base: Journey;
  index: RepositoryIndex;
};

const Snapshot = z.strictObject({
  /** Journey base id. Absent in hand-made snapshots, which use the repository name (ids already in use). */
  id: z.string().regex(/^[a-z0-9-]+$/).optional(),
  owner: z.string().min(1),
  name: z.string().regex(/^[A-Za-z0-9._-]+$/),
  url: z.string().url(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  branch: z.string().min(1).optional(),
  fetchedAt: z.iso.datetime().optional(),
  files: z.array(z.string()).optional(),
});

export function loadRepositorySource(dir: string): RepositorySource {
  const { owner, name, url, sha, id } = Snapshot.parse(JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")));
  const repo = { owner, name, url, sha };
  const index = indexRepository(originalDir(dir));
  if (index.files.size === 0) throw new Error(`${repo.owner}/${repo.name}: original/ não contém nenhum arquivo .ts.`);
  const base: Journey = {
    id: id ?? repo.name,
    title: repo.name,
    description: `Percursos gerados por análise estática de ${repo.owner}/${repo.name}.`,
    repo,
    goal: FROM_SCRATCH,
    codeMap: {},
    status: "ready",
    concepts: [],
    modules: [],
    stages: [],
  };
  return { base, index };
}

export function loadRepositorySources(root: string): RepositorySource[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(root, entry.name, "snapshot.json")))
    .map((entry) => loadRepositorySource(join(root, entry.name)));
}
