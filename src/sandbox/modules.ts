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
      throw new ModuleError(`${file.path}: ${syntaxMessage(error)}`);
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

type ExerciseParts = { starterFiles: CodeFile[]; supportFiles: CodeFile[]; expose: string[]; testFile: CodeFile };

/**
 * Builds the runnable module set for an exercise from what the learner wrote.
 * The learner writes plain code from a blank editor; module plumbing is done here:
 * - names the tests need are exported if the learner didn't write `export`;
 * - names provided by read-only support files are imported when the learner uses them
 *   without declaring them (only the new idea has to be rewritten).
 */
export function prepareExercise(exercise: ExerciseParts, learnerFiles: CodeFile[]): ModuleSet {
  return prepareModules(completeExercise(exercise, learnerFiles), exercise.testFile);
}

/** Learner files with the module plumbing added, followed by the read-only support files. */
export function completeExercise(exercise: ExerciseParts, learnerFiles: CodeFile[]): CodeFile[] {
  const written = exercise.starterFiles.map((starter) => learnerFiles.find((file) => file.path === starter.path) ?? starter);
  const completed = written.map((file, index) => completeLearnerFile(file, exercise.supportFiles, index === 0 ? exercise.expose : []));
  return [...completed, ...exercise.supportFiles];
}

function completeLearnerFile(file: CodeFile, supportFiles: CodeFile[], expose: string[]): CodeFile {
  const source = file.content;
  const exported = new Set(scanExports(file));
  const declared = (name: string): boolean =>
    new RegExp(`\\b(?:function\\*?|const|let|var|class|enum|interface|type)\\s+${escapeName(name)}\\b`).test(source) ||
    // Learners who write their own imports keep them; nothing is added twice.
    new RegExp(`\\bimport\\b[^;]*[\\s{,]${escapeName(name)}[\\s},][^;]*\\bfrom\\b`).test(source);

  const imports = supportFiles.flatMap((support) => {
    const names = scanExports(support).filter(
      (name) => name !== "default" && !declared(name) && new RegExp(`(^|[^\\w$])${escapeName(name)}($|[^\\w$])`).test(source),
    );
    return names.length ? [`import { ${names.join(", ")} } from "./${support.path}";`] : [];
  });

  const missing = expose.filter((name) => !exported.has(name));
  const undeclared = missing.filter((name) => !declared(name));
  if (undeclared.length > 0) {
    throw new ModuleError(`Não encontrei ${undeclared.map((n) => `\`${n}\``).join(", ")} em ${file.path}. Crie com exatamente esse nome.`);
  }
  const exports = missing.length ? [`export { ${missing.join(", ")} };`] : [];
  // Imports share the first line, so reported line numbers match what the learner sees.
  const head = imports.length ? imports.join(" ") + " " : "";
  return { path: file.path, content: [head + source, ...exports].join("\n") };
}

const escapeName = (name: string): string => name.replace(/\$/g, "\\$");

function scanExports(file: CodeFile): string[] {
  try {
    return transpiler.scan(file.content).exports;
  } catch (error) {
    throw new ModuleError(`${file.path}: ${syntaxMessage(error)}`);
  }
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

/** Bun reports parse failures as an AggregateError whose entries carry line/column. */
function syntaxMessage(error: unknown): string {
  const first = error instanceof AggregateError ? (error.errors[0] as { message?: unknown; position?: { line?: unknown } } | undefined) : undefined;
  const line = typeof first?.position?.line === "number" ? `linha ${first.position.line}: ` : "";
  const detail = typeof first?.message === "string" ? first.message : error instanceof Error ? error.message : String(error);
  return `erro de sintaxe — ${line}${detail}`;
}
