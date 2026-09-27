import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { FileChange } from "./domain.ts";
import { minimalEnv, runCommand } from "./command.ts";
import type { CandidateWorkspace, Workspace } from "./ports.ts";

const GIT_TIMEOUT_MS = 60_000;

/**
 * Candidates live in their own `git worktree`, detached at the baseline revision.
 * The baseline checkout is never touched; candidate revisions are kept under
 * refs/habitat/candidates/* so failed candidates remain inspectable.
 * Isolation of files, not of processes: NOT A SECURITY BOUNDARY.
 */
export class GitWorktreeWorkspace implements CandidateWorkspace {
  constructor(
    private readonly repository: string,
    private readonly root: string,
    /** Shared read-only toolchain (node_modules) linked into each worktree; never installed per candidate. */
    private readonly linkDirs: string[] = ["node_modules"],
  ) {}

  async prepare(id: string, revision: string): Promise<Workspace> {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`invalid workspace id ${id}`);
    mkdirSync(this.root, { recursive: true });
    const dir = join(this.root, id);
    if (existsSync(dir)) await this.remove(dir);
    await this.git(["worktree", "add", "--detach", dir, revision]);
    for (const name of this.linkDirs) {
      const source = join(this.repository, name);
      if (existsSync(source)) symlinkSync(source, join(dir, name), "dir");
    }
    return { id, dir, revision };
  }

  async mutate(workspace: Workspace, patch: string, message: string): Promise<{ revision: string; changes: FileChange[] }> {
    const patchFile = join(this.root, `${workspace.id}.patch`);
    await Bun.write(patchFile, patch);
    try {
      await this.git(["apply", "--index", "--whitespace=nowarn", patchFile], workspace.dir);
    } finally {
      rmSync(patchFile, { force: true });
    }
    await this.git(["-c", "user.name=OWNR Habitat", "-c", "user.email=habitat@ownr.local", "commit", "--no-verify", "--quiet", "-m", message], workspace.dir);
    const revision = (await this.git(["rev-parse", "HEAD"], workspace.dir)).trim();
    return { revision, changes: await this.changes(workspace.revision, revision) };
  }

  async retain(id: string, revision: string): Promise<void> {
    await this.git(["update-ref", `refs/habitat/candidates/${id}`, revision]);
  }

  async dispose(workspace: Workspace): Promise<void> {
    await this.remove(workspace.dir);
  }

  async changes(from: string, to: string): Promise<FileChange[]> {
    // --raw exposes file modes, so a symlink (120000) cannot hide behind an ordinary path.
    const raw = await this.git(["diff", "--raw", "--no-renames", "-z", from, to]);
    const fields = raw.split("\0").filter(Boolean);
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = fields[i] ?? "";
      const path = fields[i + 1] ?? "";
      const [oldMode = "", newMode = "", , , status = ""] = meta.replace(/^:/, "").split(" ");
      changes.push({ path, status, oldMode, newMode });
    }
    return changes;
  }

  async diff(from: string, to: string): Promise<string> {
    return this.git(["diff", "--stat", "--patch", from, to]);
  }

  async headRevision(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  private async remove(dir: string): Promise<void> {
    // git may already have forgotten the worktree (e.g. a crash mid-prepare): the rm below is the real cleanup.
    await this.git(["worktree", "remove", "--force", dir]).catch(() => "already gone");
    rmSync(dir, { recursive: true, force: true });
    await this.git(["worktree", "prune"]);
  }

  private async git(args: string[], cwd = this.repository): Promise<string> {
    const result = await runCommand(["git", ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, env: minimalEnv() });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} falhou: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    return result.stdout;
  }
}
