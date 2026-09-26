import type { CodeFile } from "../domain/stage.ts";
import { HARNESS_SPECIFIER } from "./runner.ts";

export type PreparedModule = {
  path: string;
  /** Transpiled JavaScript (ESM). */
  code: string;
  /** Relative specifiers exactly as written, each mapped to a module path. */
  imports: Record<string, string>;
};

export type ModuleSet = { entry: string; modules: PreparedModule[] };

export class ModuleError extends Error {
  override readonly name = "ModuleError";
}

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

/**
 * Type-strips learner files + the stage tests into ESM without executing them.
 * Only relative imports between the provided files (and the harness) are
 * allowed: no packages, no network, no dynamic import, no require.
 */
export function prepareModules(files: CodeFile[], testFile: CodeFile): ModuleSet {
  const all = [...files, testFile];
  const known = new Set(all.map((file) => file.path));
  const modules = all.map((file): PreparedModule => {
    const imports: Record<string, string> = {};
    let scanned: ReturnType<typeof transpiler.scanImports>;
    let code: string;
    try {
      scanned = transpiler.scanImports(file.content);
      code = transpiler.transformSync(file.content);
    } catch (error) {
      throw new ModuleError(`${file.path}: erro de sintaxe — ${firstLine(error)}`);
    }
    for (const { path, kind } of scanned) {
      if (path === HARNESS_SPECIFIER && kind === "import-statement") continue;
      const target = resolveRelative(path);
      if (kind !== "import-statement" || !target || !known.has(target)) {
        throw new ModuleError(`${file.path}: import não permitido "${path}" — use apenas arquivos desta etapa`);
      }
      imports[path] = target;
    }
    return { path: file.path, code, imports };
  });
  return { entry: testFile.path, modules: orderByDependencies(modules) };
}

function resolveRelative(specifier: string): string | undefined {
  const match = /^\.\/([a-z0-9-]+)(\.ts|\.js)?$/.exec(specifier);
  return match ? `${match[1]}.ts` : undefined;
}

/** Dependencies first, so a linker can create each module after its imports. */
function orderByDependencies(modules: PreparedModule[]): PreparedModule[] {
  const byPath = new Map(modules.map((module) => [module.path, module]));
  const ordered: PreparedModule[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (module: PreparedModule): void => {
    const current = state.get(module.path);
    if (current === "done") return;
    if (current === "visiting") throw new ModuleError(`import circular envolvendo ${module.path}`);
    state.set(module.path, "visiting");
    for (const target of Object.values(module.imports)) {
      const dependency = byPath.get(target);
      if (dependency) visit(dependency);
    }
    state.set(module.path, "done");
    ordered.push(module);
  };
  modules.forEach(visit);
  return ordered;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
