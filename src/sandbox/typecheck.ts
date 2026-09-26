import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeFile } from "../domain/stage.ts";
import { readBounded } from "./process.ts";

export type TypeDiagnostic = { file: string; line: number; code: string; message: string };

export class TypecheckBusyError extends Error {
  override readonly name = "TypecheckBusyError";
}

const TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DIAGNOSTICS = 20;
const DIAGNOSTIC = /^(?<file>[a-z0-9-]+\.ts)\((?<line>\d+),\d+\): error (?<code>TS\d+): (?<message>.*)$/;

// --noResolve: only the stage's own files are in the program. Nothing the learner
// writes (/// <reference>, import("/etc/..."), a package name) can pull other files in.
// --strict false: verify the concept being taught (checks come from the stage's type-level
// files), not annotations the journey has not asked for yet (TS 7 is strict by default).
const FLAGS = [
  "--noEmit",
  "--noResolve",
  "--strict", "false",
  "--pretty", "false",
  "--target", "es2022",
  "--module", "esnext",
  "--moduleResolution", "bundler",
  "--allowImportingTsExtensions",
  "--skipLibCheck",
  "--types", "",
];

/**
 * Real TypeScript diagnostics for stages where types are what is being taught.
 * Runs the native `tsc` already shipped with the `typescript` package: it only
 * reads the files and reports errors — learner code is never executed here.
 * Not a language server: one short-lived process per check, bounded in time,
 * output and concurrency.
 */
export class TypeChecker {
  private active = 0;

  constructor(
    private readonly executable: string,
    private readonly maxConcurrent = 2,
  ) {}

  async check(files: CodeFile[]): Promise<TypeDiagnostic[]> {
    if (this.active >= this.maxConcurrent) throw new TypecheckBusyError("typecheck busy");
    this.active += 1;
    const dir = await mkdtemp(join(tmpdir(), "rr-tsc-"));
    try {
      // CodeFile paths are validated as bare "name.ts": no directories, no traversal.
      await Promise.all(files.map((file) => Bun.write(join(dir, file.path), file.content)));
      return await this.run(dir, files.map((file) => file.path));
    } finally {
      this.active -= 1;
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async run(cwd: string, paths: string[]): Promise<TypeDiagnostic[]> {
    const proc = Bun.spawn([this.executable, ...FLAGS, ...paths], { cwd, stdout: "pipe", stderr: "pipe", env: {} });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(proc.stdout, MAX_OUTPUT_BYTES, () => proc.kill()),
      readBounded(proc.stderr, MAX_OUTPUT_BYTES, () => proc.kill()),
      proc.exited,
    ]);
    clearTimeout(timer);

    if (timedOut) return [{ file: paths[0] ?? "", line: 1, code: "TIMEOUT", message: "A verificação de tipos demorou demais." }];
    if (exitCode === 0) return [];
    const diagnostics = parseDiagnostics(stdout);
    if (diagnostics.length > 0) return diagnostics;
    throw new Error(`tsc exited with ${exitCode}: ${(stderr || stdout).slice(0, 200)}`);
  }
}

export function parseDiagnostics(output: string): TypeDiagnostic[] {
  const diagnostics: TypeDiagnostic[] = [];
  for (const line of output.split("\n")) {
    const groups = DIAGNOSTIC.exec(line.trim())?.groups;
    if (!groups?.file || !groups.line || !groups.code || groups.message === undefined) continue;
    diagnostics.push({ file: groups.file, line: Number(groups.line), code: groups.code, message: groups.message });
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
  }
  return diagnostics;
}

/** The native compiler binary the `typescript` package ships for this platform. */
export async function locateTsc(): Promise<string> {
  const packageDir = dirname(Bun.resolveSync("typescript/package.json", import.meta.dir));
  const module: { default: () => string } = await import(join(packageDir, "lib/getExePath.js"));
  return module.default();
}
