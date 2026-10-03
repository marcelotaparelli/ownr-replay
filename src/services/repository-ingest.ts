import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { originalDir } from "./code-map.ts";
import type { GithubRepo } from "./repo-url.ts";
import { loadRepositorySource, type RepositorySource } from "./repository-snapshot.ts";

/**
 * GitHub URL → pinned snapshot, with the least that analysis needs: the SHA of the default branch,
 * the TypeScript sources of that exact commit, and nothing else. The repository is never cloned,
 * never installed, built or executed: files are fetched as text from two fixed GitHub hosts and
 * written under data/repositories/<id>/original/ only after every limit has passed.
 */

export const INGEST_LIMITS = {
  /** Regular .ts files kept; a repository above this is rejected, not silently truncated. */
  maxFiles: 400,
  maxFileBytes: 200_000,
  maxTotalBytes: 4_000_000,
  /** The tree listing of a monorepo can be large; this bounds the response, not the repository. */
  maxTreeResponseBytes: 8_000_000,
  maxMetadataResponseBytes: 64_000,
  fetchConcurrency: 8,
  requestTimeoutMs: 15_000,
  totalTimeoutMs: 45_000,
} as const;

export type IngestErrorCode = "REPO_NOT_FOUND" | "DOWNLOAD_FAILED" | "LIMIT_EXCEEDED" | "NO_SUPPORTED_CODE" | "UNSAFE_PATH";

/** An expected, learner-visible failure of ingestion; the message is safe to show. */
export class IngestError extends Error {
  constructor(readonly code: IngestErrorCode, message: string) {
    super(message);
  }
}

export type TreeEntry = { path: string; mode: string; type: string; size: number };
export type RepoHead = { branch: string; sha: string };

/** The one boundary of ingestion: what is read from GitHub. Replaced by a fake in tests. */
export interface GithubSource {
  head(repo: GithubRepo, signal: AbortSignal): Promise<RepoHead>;
  tree(repo: GithubRepo, sha: string, signal: AbortSignal): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  file(repo: GithubRepo, sha: string, path: string, signal: AbortSignal): Promise<string>;
}

// ---------- selection: which tree entries are worth downloading ----------

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "vendor", "__tests__", "__mocks__", ".git", ".github"]);
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
const TEST_FILE = /\.(?:test|spec)\.ts$/;

function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 300 || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git");
}

/** Pure: applies the file filter and every limit to a repository tree, before anything is downloaded. */
export function selectSources(entries: readonly TreeEntry[]): TreeEntry[] {
  const selected: TreeEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    // Symlinks (mode 120000) and submodules are never followed: only regular files are ever fetched.
    if (entry.type !== "blob" || !REGULAR_FILE_MODES.has(entry.mode)) continue;
    if (!entry.path.endsWith(".ts") || entry.path.endsWith(".d.ts") || TEST_FILE.test(entry.path)) continue;
    if (!isSafePath(entry.path)) throw new IngestError("UNSAFE_PATH", `Caminho inseguro no repositório: ${entry.path.slice(0, 80)}`);
    if (entry.path.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment))) continue;
    if (entry.size > INGEST_LIMITS.maxFileBytes) throw new IngestError("LIMIT_EXCEEDED", `${entry.path} tem ${entry.size} bytes; o limite por arquivo é ${INGEST_LIMITS.maxFileBytes}.`);
    totalBytes += entry.size;
    selected.push(entry);
    if (selected.length > INGEST_LIMITS.maxFiles) throw new IngestError("LIMIT_EXCEEDED", `O repositório tem mais de ${INGEST_LIMITS.maxFiles} arquivos .ts; este é o limite desta versão.`);
    if (totalBytes > INGEST_LIMITS.maxTotalBytes) throw new IngestError("LIMIT_EXCEEDED", `O código .ts passa de ${INGEST_LIMITS.maxTotalBytes} bytes; este é o limite desta versão.`);
  }
  if (selected.length === 0) throw new IngestError("NO_SUPPORTED_CODE", "Nenhum código TypeScript (.ts) suportado foi encontrado neste repositório.");
  return selected;
}

// ---------- GitHub over HTTPS (the only network code) ----------

const API_HOST = "https://api.github.com";
const RAW_HOST = "https://raw.githubusercontent.com";
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

const RepoResponse = z.object({ default_branch: z.string().min(1).max(255) });
const FULL_SHA = /^[0-9a-f]{40}$/;
const TreeResponse = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), size: z.number().int().nonnegative().optional() })),
});

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new IngestError("LIMIT_EXCEEDED", `Resposta do GitHub maior que o limite de ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class GithubHttpSource implements GithubSource {
  /** Only fixed hosts, no redirects, no credentials: nothing the repository says can change where we connect. */
  private async get(url: string, accept: string, maxBytes: number, signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept, "user-agent": "ownr-replay", "x-github-api-version": "2022-11-28" },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(INGEST_LIMITS.requestTimeoutMs)]),
      });
    } catch {
      throw new IngestError("DOWNLOAD_FAILED", "Não foi possível falar com o GitHub (rede, timeout ou repositório renomeado). Tente novamente.");
    }
    if (response.status === 404) throw new IngestError("REPO_NOT_FOUND", "Repositório não encontrado: ele não existe ou é privado/inacessível. Esta versão lê só repositórios públicos do GitHub.");
    if (response.status === 403 || response.status === 429) throw new IngestError("DOWNLOAD_FAILED", "O GitHub recusou a requisição (provável limite de requisições sem autenticação). Tente mais tarde.");
    if (!response.ok) throw new IngestError("DOWNLOAD_FAILED", `O GitHub respondeu com status ${response.status}.`);
    try {
      return await readCapped(response, maxBytes);
    } catch (error) {
      if (error instanceof IngestError) throw error;
      throw new IngestError("DOWNLOAD_FAILED", "A transferência do GitHub foi interrompida.");
    }
  }

  private async json<S extends z.ZodType>(url: string, schema: S, maxBytes: number, signal: AbortSignal): Promise<z.infer<S>> {
    const text = await this.get(url, "application/vnd.github+json", maxBytes, signal);
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      throw new IngestError("DOWNLOAD_FAILED", "Resposta inesperada da API do GitHub.");
    }
  }

  async head(repo: GithubRepo, signal: AbortSignal): Promise<RepoHead> {
    const base = `${API_HOST}/repos/${repo.owner}/${repo.name}`;
    const { default_branch: branch } = await this.json(base, RepoResponse, INGEST_LIMITS.maxMetadataResponseBytes, signal);
    // The sha media type returns just the 40-hex commit id, not the commit's (possibly huge) file list.
    const sha = (await this.get(`${base}/commits/${encodePath(branch)}`, "application/vnd.github.sha", 100, signal)).trim();
    if (!FULL_SHA.test(sha)) throw new IngestError("DOWNLOAD_FAILED", "Resposta inesperada da API do GitHub.");
    return { branch, sha };
  }

  async tree(repo: GithubRepo, sha: string, signal: AbortSignal): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const body = await this.json(`${API_HOST}/repos/${repo.owner}/${repo.name}/git/trees/${sha}?recursive=1`, TreeResponse, INGEST_LIMITS.maxTreeResponseBytes, signal);
    return { truncated: body.truncated, entries: body.tree.map((entry) => ({ path: entry.path, mode: entry.mode, type: entry.type, size: entry.size ?? 0 })) };
  }

  file(repo: GithubRepo, sha: string, path: string, signal: AbortSignal): Promise<string> {
    return this.get(`${RAW_HOST}/${repo.owner}/${repo.name}/${sha}/${encodePath(path)}`, "text/plain", INGEST_LIMITS.maxFileBytes, signal);
  }
}

// ---------- snapshot store ----------

export type SnapshotResult = { source: RepositorySource; cached: boolean };

/** Runs `task` over `items` with at most `limit` in flight; the first failure stops the rest. */
async function mapBounded<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Journeys of different commits must never share an id: the sha is part of the snapshot's identity. */
export const snapshotId = (repo: GithubRepo, sha: string): string => slug(`${repo.owner}-${repo.name}-${sha.slice(0, 7)}`);

export class SnapshotIngestor {
  private readonly inflight = new Map<string, Promise<SnapshotResult>>();
  private readonly sources: RepositorySource[];

  constructor(private readonly root: string, private readonly github: GithubSource, known: readonly RepositorySource[], private readonly now: () => Date = () => new Date()) {
    this.sources = [...known];
  }

  /** The snapshot of the repository's current default-branch commit: reused if present, ingested once if not. */
  async ensure(repo: GithubRepo): Promise<SnapshotResult> {
    const signal = AbortSignal.timeout(INGEST_LIMITS.totalTimeoutMs);
    const head = await this.github.head(repo, signal);
    const known = this.find(repo, head.sha);
    if (known) return { source: known, cached: true };
    // Concurrent requests for the same commit share one download.
    const key = `${repo.owner}/${repo.name}@${head.sha}`.toLowerCase();
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.ingest(repo, head, signal).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private find(repo: GithubRepo, sha: string): RepositorySource | undefined {
    return this.sources.find(({ base }) => base.repo.sha === sha && base.repo.owner.toLowerCase() === repo.owner.toLowerCase() && base.repo.name.toLowerCase() === repo.name.toLowerCase());
  }

  private async ingest(repo: GithubRepo, head: RepoHead, signal: AbortSignal): Promise<SnapshotResult> {
    const { entries, truncated } = await this.github.tree(repo, head.sha, signal);
    if (truncated) throw new IngestError("LIMIT_EXCEEDED", "A árvore do repositório é grande demais para esta versão.");
    const selected = selectSources(entries);
    const contents = await mapBounded(selected, INGEST_LIMITS.fetchConcurrency, (entry) => this.github.file(repo, head.sha, entry.path, signal));
    if (contents.reduce((total, content) => total + Buffer.byteLength(content), 0) > INGEST_LIMITS.maxTotalBytes) {
      throw new IngestError("LIMIT_EXCEEDED", `O código .ts passa de ${INGEST_LIMITS.maxTotalBytes} bytes; este é o limite desta versão.`);
    }

    const id = snapshotId(repo, head.sha);
    const finalDir = join(this.root, id);
    const staging = join(this.root, `.ingest-${crypto.randomUUID()}`);
    try {
      selected.forEach((entry, i) => {
        const target = join(originalDir(staging), entry.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents[i]!);
      });
      const record = { id, owner: repo.owner, name: repo.name, url: repo.url, sha: head.sha, branch: head.branch, fetchedAt: this.now().toISOString(), files: selected.map((entry) => entry.path) };
      writeFileSync(join(staging, "snapshot.json"), JSON.stringify(record, null, 2));
      // One rename publishes the snapshot whole or not at all; an existing directory is never overwritten.
      if (existsSync(finalDir)) throw new IngestError("DOWNLOAD_FAILED", `O diretório ${id} já existe e não pertence a um snapshot carregado.`);
      renameSync(staging, finalDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const source = loadRepositorySource(finalDir);
    this.sources.push(source);
    return { source, cached: false };
  }
}
