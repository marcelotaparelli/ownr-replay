import { test, expect, afterEach, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resilientSource, testApp } from "./helpers.ts";
import { locateTsc, TypeChecker } from "../src/sandbox/typecheck.ts";
import { parseGithubRepoUrl } from "../src/services/repo-url.ts";
import { GithubHttpSource, IngestError, INGEST_LIMITS, SnapshotIngestor, selectSources, snapshotId, type GithubSource, type RepoHead, type TreeEntry } from "../src/services/repository-ingest.ts";
import { loadRepositorySources } from "../src/services/repository-snapshot.ts";
import { ModuleGenerationService, StageGenerator, StagePlanner, StageValidator } from "../src/services/stage-generation.ts";

/**
 * GitHub URL → SHA → snapshot → journey, with GitHub replaced by a fake: the network is the only
 * thing that changes between these tests and production, so everything else is the real code.
 */
const checker = new TypeChecker(await locateTsc());
const PERSISTENCE_GOAL = "Quero entender como uma transação é persistida no banco de dados.";
const URL_A = "https://github.com/acme/payments-api";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const tempRoot = (): string => mkdtempSync(join(tmpdir(), "replay-ingest-"));
const resilientFiles = (): Map<string, string> => new Map(resilientSource().index.files);

type FakeState = { head: RepoHead; files: Map<string, string>; extraEntries: TreeEntry[]; failure?: IngestError; fileFailure?: { after: number } };
type FakeGithub = GithubSource & { state: FakeState; calls: { head: number; tree: number; files: string[] } };

/** A GitHub that serves `files` as its default branch, and counts every request made to it. */
function fakeGithub(files: Map<string, string> = resilientFiles()): FakeGithub {
  const state: FakeState = { head: { branch: "main", sha: SHA_A }, files, extraEntries: [] };
  const calls = { head: 0, tree: 0, files: [] as string[] };
  return {
    state,
    calls,
    async head() {
      calls.head++;
      if (state.failure) throw state.failure;
      return state.head;
    },
    async tree() {
      calls.tree++;
      const entries = [...state.files].map(([path, content]) => ({ path, mode: "100644", type: "blob", size: Buffer.byteLength(content) }));
      return { entries: [...entries, ...state.extraEntries], truncated: false };
    },
    async file(_repo, _sha, path) {
      calls.files.push(path);
      if (state.fileFailure && calls.files.length > state.fileFailure.after) throw new IngestError("DOWNLOAD_FAILED", "falha simulada");
      const content = state.files.get(path);
      if (content === undefined) throw new IngestError("DOWNLOAD_FAILED", "arquivo ausente");
      return content;
    },
  };
}

const appWith = (root: string, github: GithubSource) => {
  const generation = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const ingest = new SnapshotIngestor(join(root, "repositories"), github, []);
  return { ...testApp({ generation, ingest }), ingest };
};
const request = (app: { call: ReturnType<typeof testApp>["call"] }, repoUrl: string, goal: unknown = { kind: "other", note: PERSISTENCE_GOAL }) => app.call("POST", "/api/journeys", { repoUrl, goal });

// ---------- URL → snapshot → journey ----------

test("repositório ausente localmente: URL → SHA → snapshot em disco → jornada que abre", async () => {
  const root = tempRoot();
  const github = fakeGithub();
  const app = appWith(root, github);

  const res = await request(app, URL_A);
  expect(res.status).toBe(200);
  const { id, startOrder } = (await res.json()) as { id: string; startOrder: number };
  expect(startOrder).toBe(1);
  expect(id.startsWith(`${snapshotId({ owner: "acme", name: "payments-api", url: URL_A }, SHA_A)}--`)).toBe(true);

  const journey = (await (await app.call("GET", `/api/journeys/${id}`)).json()) as { repo: { owner: string; name: string; sha: string; url: string }; stages: { kind: string }[] };
  expect(journey.repo).toEqual({ owner: "acme", name: "payments-api", url: URL_A, sha: SHA_A });
  expect(journey.stages.at(-1)?.kind).toBe("checkpoint");

  const dir = join(root, "repositories", snapshotId({ owner: "acme", name: "payments-api", url: URL_A }, SHA_A));
  const record = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")) as Record<string, unknown>;
  expect(record).toMatchObject({ owner: "acme", name: "payments-api", url: URL_A, sha: SHA_A, branch: "main" });
  expect(Date.parse(String(record.fetchedAt))).toBeGreaterThan(0);
  expect(record.files).toEqual([...github.state.files.keys()]);
  for (const path of github.state.files.keys()) expect(existsSync(join(dir, "original", path))).toBe(true);
  expect(readdirSync(join(root, "repositories")).filter((name) => name.startsWith("."))).toEqual([]);
  // What was written is what a restart loads: same id, same pinned identity, only the four repo fields.
  const [reloaded] = loadRepositorySources(join(root, "repositories"));
  expect(reloaded?.base.repo).toEqual(journey.repo);
  expect(reloaded?.index.files.size).toBe(github.state.files.size);
});

test("trace_request também parte de uma URL nunca vista", async () => {
  const app = appWith(tempRoot(), fakeGithub());
  const res = await request(app, URL_A, { kind: "trace_request", target: PERSISTENCE_GOAL });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { startOrder: number }).startOrder).toBe(1);
});

test("mesmo repositório e SHA: reutiliza o snapshot e não baixa de novo", async () => {
  const root = tempRoot();
  const github = fakeGithub();
  const app = appWith(root, github);
  const first = (await (await request(app, URL_A)).json()) as { id: string };
  const downloaded = [github.calls.tree, github.calls.files.length];

  // Same goal → the very same journey; another goal → a new journey on the same snapshot.
  const again = (await (await request(app, URL_A)).json()) as { id: string };
  const other = (await (await request(app, URL_A, { kind: "trace_request", target: "Quero entender como funciona a autenticação das requisições" })).json()) as { id: string };
  expect(again.id).toBe(first.id);
  expect(other.id).not.toBe(first.id);
  expect([github.calls.tree, github.calls.files.length]).toEqual(downloaded);

  // A restart finds the snapshot on disk: the ingestor starts from what was loaded, with no download.
  const rebooted = fakeGithub();
  const ingest = new SnapshotIngestor(join(root, "repositories"), rebooted, loadRepositorySources(join(root, "repositories")));
  const { cached } = await ingest.ensure({ owner: "Acme", name: "Payments-API", url: URL_A });
  expect(cached).toBe(true);
  expect([rebooted.calls.tree, rebooted.calls.files.length]).toEqual([0, 0]);
});

test("pedidos simultâneos do mesmo commit compartilham um único download", async () => {
  const github = fakeGithub();
  const ingest = new SnapshotIngestor(tempRoot(), github, []);
  const repo = parseGithubRepoUrl(URL_A)!;
  const [a, b] = await Promise.all([ingest.ensure(repo), ingest.ensure(repo)]);
  expect(a.source.base.id).toBe(b.source.base.id);
  expect(github.calls.tree).toBe(1);
});

test("o repositório muda: jornadas antigas ficam no SHA A e a nova ingestão usa o SHA B", async () => {
  const root = tempRoot();
  const github = fakeGithub();
  const app = appWith(root, github);
  const a = (await (await request(app, URL_A)).json()) as { id: string };
  const before = await (await app.call("GET", `/api/journeys/${a.id}`)).text();

  github.state.head = { branch: "main", sha: SHA_B };
  github.state.files.set("src/config.ts", `${github.state.files.get("src/config.ts")}\n// changed upstream\n`);
  const b = (await (await request(app, URL_A)).json()) as { id: string };

  expect(b.id).not.toBe(a.id);
  const journeyB = (await (await app.call("GET", `/api/journeys/${b.id}`)).json()) as { repo: { sha: string } };
  expect(journeyB.repo.sha).toBe(SHA_B);
  // Nothing about the old journey or its snapshot was rewritten.
  expect(await (await app.call("GET", `/api/journeys/${a.id}`)).text()).toBe(before);
  const snapshots = readdirSync(join(root, "repositories")).sort();
  expect(snapshots).toEqual([snapshotId({ owner: "acme", name: "payments-api", url: URL_A }, SHA_A), snapshotId({ owner: "acme", name: "payments-api", url: URL_A }, SHA_B)].sort());
  expect(readFileSync(join(root, "repositories", snapshots[0]!, "original/src/config.ts"), "utf8")).not.toContain("changed upstream");
  const listed = (await (await app.call("GET", "/api/journeys")).json()) as { id: string; repo: { name: string; sha: string } }[];
  expect(listed.filter((j) => j.repo.name === "payments-api").map((j) => j.repo.sha).sort()).toEqual([SHA_A, SHA_B]);
});

// ---------- rejections: nothing reaches GitHub ----------

test.each([
  ["texto qualquer", "isto não é uma url"],
  ["SSH", "git@github.com:acme/payments-api.git"],
  ["ssh://", "ssh://git@github.com/acme/payments-api"],
  ["file://", "file:///etc/passwd"],
  ["http sem TLS", "http://github.com/acme/payments-api"],
  ["localhost", "https://localhost/acme/payments-api"],
  ["IPv4", "https://127.0.0.1/acme/payments-api"],
  ["IPv6", "https://[::1]/acme/payments-api"],
  ["outro host", "https://gitlab.com/acme/payments-api"],
  ["subdomínio", "https://www.github.com/acme/payments-api"],
  ["host que contém github.com", "https://github.com.evil.example/acme/payments-api"],
  ["credenciais na URL", "https://github.com@evil.example/acme/payments-api"],
  ["porta", "https://github.com:8443/acme/payments-api"],
  ["caminho extra", "https://github.com/acme/payments-api/tree/main"],
  ["travessia", "https://github.com/acme/../payments-api"],
])("rejeita %s sem tocar o GitHub", async (_label, repoUrl) => {
  const github = fakeGithub();
  const res = await request(appWith(tempRoot(), github), repoUrl);
  expect(res.status).toBe(422);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_REPO_URL");
  expect(github.calls.head).toBe(0);
});

test.each([
  ["REPO_NOT_FOUND", 404],
  ["DOWNLOAD_FAILED", 502],
  ["LIMIT_EXCEEDED", 422],
  ["NO_SUPPORTED_CODE", 422],
] as const)("falha %s é explícita, sem jornada e sem fallback para outro repositório", async (code, status) => {
  const root = tempRoot();
  const github = fakeGithub();
  github.state.failure = new IngestError(code, "mensagem explícita");
  const app = appWith(root, github);
  const recorded = spyOn(app.repository, "recordJourneyRequest");
  const res = await request(app, "https://github.com/acme/missing-repo");
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string }; fallback?: unknown };
  expect(body.error).toEqual({ code, message: "mensagem explícita" });
  expect(body.fallback).toBeUndefined();
  expect(existsSync(join(root, "repositories"))).toBe(false);
  expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", name: "missing-repo", served: false }));
});

test("repositório sem código TypeScript é rejeitado e nada é gravado", async () => {
  const root = tempRoot();
  const app = appWith(root, fakeGithub(new Map([["index.js", "module.exports = 1;"], ["README.md", "# x"]])));
  const res = await request(app, URL_A);
  expect(res.status).toBe(422);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NO_SUPPORTED_CODE");
  expect(existsSync(join(root, "repositories"))).toBe(false);
});

test("falha no meio do download não deixa snapshot parcial nem diretório temporário", async () => {
  const root = tempRoot();
  const github = fakeGithub();
  github.state.fileFailure = { after: 3 };
  const res = await request(appWith(root, github), URL_A);
  expect(res.status).toBe(502);
  // Files are fetched into memory and published with one rename, so a failure leaves nothing on disk.
  expect(existsSync(join(root, "repositories"))).toBe(false);
});

// ---------- ingestion never executes what it downloads ----------

test("a ingestão só lê arquivos .ts e não executa scripts, hooks nem instala nada", async () => {
  const root = tempRoot();
  const marker = join(root, "EXECUTED");
  const files = resilientFiles();
  files.set("src/evil.ts", `await Bun.write(${JSON.stringify(marker)}, "pwned");\nexport const evil = 1;\n`);
  const github = fakeGithub(files);
  github.state.extraEntries.push(
    { path: "package.json", mode: "100644", type: "blob", size: 80 },
    { path: ".husky/pre-commit", mode: "100755", type: "blob", size: 20 },
    { path: ".github/scripts/hook.ts", mode: "100755", type: "blob", size: 20 },
    { path: "install.sh", mode: "100755", type: "blob", size: 20 },
  );
  const ingest = new SnapshotIngestor(join(root, "repositories"), github, []);
  const { source } = await ingest.ensure(parseGithubRepoUrl(URL_A)!);

  expect(existsSync(marker)).toBe(false);
  expect(github.calls.files.every((path) => path.endsWith(".ts") && !path.startsWith(".github/"))).toBe(true);
  expect(github.calls.files).not.toContain("package.json");
  // Indexing reads the text of the file; it never imports it.
  expect(source.index.files.get("src/evil.ts")).toContain("Bun.write");
  const written = readdirSync(join(root, "repositories", source.base.id), { recursive: true }).map(String);
  expect(written.some((path) => path.includes("package.json") || path.includes("husky") || path.endsWith(".sh"))).toBe(false);

  const implementation = readFileSync(join(import.meta.dir, "../src/services/repository-ingest.ts"), "utf8");
  expect(implementation).not.toMatch(/child_process|Bun\.spawn|Bun\.\$|execSync|import\(|eval\(/);
});

// ---------- compatibility ----------

test("ops-triage-ai (jornada curada) não passa pela ingestão", async () => {
  const github = fakeGithub();
  const app = appWith(tempRoot(), github);
  const res = await request(app, "https://github.com/marcelotaparelli/ops-triage-ai", { kind: "trace_request", target: "Quero compreender o fluxo completo de um ticket" });
  expect(res.status).not.toBe(404);
  expect(github.calls.head).toBe(0);
  const listed = (await (await app.call("GET", "/api/journeys")).json()) as { id: string }[];
  expect(listed.some((j) => j.id === "ops-triage-ai")).toBe(true);
});

test("resilient-transaction-api (snapshot versionado) é reutilizado com o mesmo SHA, com os ids de sempre", async () => {
  const root = tempRoot();
  const source = resilientSource();
  const github = fakeGithub();
  github.state.head = { branch: "main", sha: source.base.repo.sha };
  const generation = new ModuleGenerationService(root, new StagePlanner(), new StageGenerator(), new StageValidator(checker));
  const app = testApp({ generation, sources: [source], ingest: new SnapshotIngestor(join(root, "repositories"), github, [source]) });

  const res = await request(app, source.base.repo.url);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect(id.startsWith("resilient-transaction-api--")).toBe(true);
  expect([github.calls.tree, github.calls.files.length]).toEqual([0, 0]);
  expect(existsSync(join(root, "repositories"))).toBe(false);
});

// ---------- selection and limits ----------

const blob = (path: string, size = 10, mode = "100644"): TreeEntry => ({ path, mode, type: "blob", size });

test("seleciona só fontes .ts regulares: ignora symlinks, submódulos, testes, .d.ts e dependências", () => {
  const picked = selectSources([
    blob("src/a.ts"),
    blob("src/a.test.ts"),
    blob("src/a.spec.ts"),
    blob("src/types.d.ts"),
    blob("node_modules/x/index.ts"),
    blob("dist/a.ts"),
    blob("src/link.ts", 10, "120000"),
    { path: "vendor-sub", mode: "160000", type: "commit", size: 0 },
    { path: "src", mode: "040000", type: "tree", size: 0 },
    blob("README.md"),
    blob("run.sh", 10, "100755"),
  ]);
  expect(picked.map((entry) => entry.path)).toEqual(["src/a.ts"]);
});

test("limites: arquivos demais, arquivo grande demais e bytes demais são rejeitados, não truncados", () => {
  const many = Array.from({ length: INGEST_LIMITS.maxFiles + 1 }, (_, i) => blob(`src/f${i}.ts`));
  expect(() => selectSources(many)).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  expect(() => selectSources([blob("src/big.ts", INGEST_LIMITS.maxFileBytes + 1)])).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  const heavy = Array.from({ length: 30 }, (_, i) => blob(`src/h${i}.ts`, INGEST_LIMITS.maxFileBytes));
  expect(() => selectSources(heavy)).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
});

test("caminhos inseguros e repositório sem .ts são rejeitados explicitamente", () => {
  for (const path of ["../escape.ts", "src/../../escape.ts", "src//x.ts", "a\\b.ts", "src/./x.ts", "/abs.ts", ".git/hooks/post-checkout.ts"]) {
    expect(() => selectSources([blob(path)])).toThrow(expect.objectContaining({ code: "UNSAFE_PATH" }));
  }
  expect(() => selectSources([blob("README.md")])).toThrow(expect.objectContaining({ code: "NO_SUPPORTED_CODE" }));
});

test("árvore truncada pela API e arquivo maior que o declarado são rejeitados", async () => {
  const truncated: GithubSource = { ...fakeGithub(), tree: async () => ({ entries: [], truncated: true }) };
  await expect(new SnapshotIngestor(tempRoot(), truncated, []).ensure(parseGithubRepoUrl(URL_A)!)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  const liar: GithubSource = { ...fakeGithub(), tree: async () => ({ entries: [blob("src/a.ts", 1)], truncated: false }), file: async () => "x".repeat(INGEST_LIMITS.maxTotalBytes + 1) };
  await expect(new SnapshotIngestor(tempRoot(), liar, []).ensure(parseGithubRepoUrl(URL_A)!)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
});

// ---------- the real HTTP source, with fetch replaced ----------

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const stubFetch = (respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): string[] => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return respond(String(input), init);
  }) as typeof fetch;
  return urls;
};
const repoA = parseGithubRepoUrl(URL_A)!;
const signal = (): AbortSignal => AbortSignal.timeout(5_000);

test("a fonte HTTP descobre branch e SHA completos falando só com api.github.com, sem redirecionar nem enviar credenciais", async () => {
  const inits: (RequestInit | undefined)[] = [];
  const urls = stubFetch((url, init) => {
    inits.push(init);
    return url.endsWith("/payments-api") ? Response.json({ default_branch: "release/1.x" }) : new Response(`${SHA_A}\n`);
  });
  expect(await new GithubHttpSource().head(repoA, signal())).toEqual({ branch: "release/1.x", sha: SHA_A });
  expect(urls).toEqual(["https://api.github.com/repos/acme/payments-api", "https://api.github.com/repos/acme/payments-api/commits/release/1.x"]);
  for (const init of inits) {
    expect(init?.redirect).toBe("error");
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization|token|cookie/i);
  }
});

test("a fonte HTTP traduz 404, limite de requisições e falha de rede em erros explícitos", async () => {
  stubFetch(() => new Response("{}", { status: 404 }));
  await expect(new GithubHttpSource().head(repoA, signal())).rejects.toMatchObject({ code: "REPO_NOT_FOUND" });
  stubFetch(() => new Response("{}", { status: 403 }));
  await expect(new GithubHttpSource().head(repoA, signal())).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  stubFetch(() => { throw new TypeError("network down"); });
  await expect(new GithubHttpSource().head(repoA, signal())).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  stubFetch(() => Response.json({ unexpected: true }));
  await expect(new GithubHttpSource().head(repoA, signal())).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
});

test("a fonte HTTP baixa arquivos só de raw.githubusercontent.com no SHA fixado e limita o tamanho", async () => {
  const urls = stubFetch(() => new Response("export const a = 1;\n"));
  expect(await new GithubHttpSource().file(repoA, SHA_A, "src/my file.ts", signal())).toBe("export const a = 1;\n");
  expect(urls).toEqual([`https://raw.githubusercontent.com/acme/payments-api/${SHA_A}/src/my%20file.ts`]);
  stubFetch(() => new Response("x".repeat(INGEST_LIMITS.maxFileBytes + 1)));
  await expect(new GithubHttpSource().file(repoA, SHA_A, "src/a.ts", signal())).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
});
