import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "typescript/unstable/async";
import {
  SyntaxKind,
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isLiteralTypeNode,
  isImportDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isNewExpression,
  isNonNullExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isReturnStatement,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeQueryNode,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  type CallExpression,
  type ClassDeclaration,
  type EntityName,
  type Expression,
  type InterfaceDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type SourceFile,
  type TypeAliasDeclaration,
  type TypeElement,
  type TypeNode,
} from "typescript/unstable/ast";
import { indexRepository } from "../services/code-map.ts";
import type { CodeSymbol, EdgeKind, ExternalCall, FlowEdge } from "../services/flow-discovery.ts";

/**
 * SPIKE (not product): a structural, AST-based replacement for the regex layer of services/flow-discovery.ts.
 * It reads the pinned sources with the TypeScript compiler's own parser (the `typescript` package this project
 * already depends on) and resolves calls ONLY from what the source declares: imports and aliases, classes,
 * extends/implements, constructor-injected and field types, declared parameter and return types, object-literal
 * implementations of a declared interface. It never guesses from a name, never reads the type checker, never
 * models runtime DI, decorators or reflection. Nothing in src/ imports this file.
 */

export type AstOptions = {
  /** `const x = svc.method()` takes x's type from method's DECLARED return type (never inferred). */
  returnTypes: boolean;
  /** An inline callback's untyped parameters take the type the resolved callee declares for that argument. */
  callbackParams: boolean;
  /** A function with a declared interface return type that returns an object literal implements that interface. */
  objectFactories: boolean;
  /** `export default { a, b }` / `const svc = { a() {} }` are namespaces whose members are callable symbols. */
  moduleObjects: boolean;
  /** Member lookup walks `extends` (classes) and `extends` (interfaces). */
  inheritance: boolean;
  /** A non-relative specifier whose tail matches exactly one repository file resolves to it (tsconfig `paths` are not ingested). */
  aliasImports: boolean;
  /** An entry point is a callable whose first parameter looks like a request (type `*Request` or name `req`/`request`). */
  entryHeuristic: boolean;
  /**
   * BEYOND declared types, off in FULL_AST: `ReturnType<typeof f>` of a function with no annotated return type is the object literal
   * it returns, member types read from the declared return types of the calls that built it. A first step toward what a checker infers.
   */
  inferReturns: boolean;
};
export const FULL_AST: AstOptions = { returnTypes: true, callbackParams: true, objectFactories: true, moduleObjects: true, inheritance: true, aliasImports: true, entryHeuristic: true, inferReturns: false };
export const INFERRED_AST: AstOptions = { ...FULL_AST, inferReturns: true };

// ---------------------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------------------

type FunctionLike = Node & { readonly parameters: readonly ParameterDeclaration[]; readonly type?: TypeNode | undefined };

type SymbolKind = "function" | "method" | "interface-member" | "object-member" | "declaration";
export type SymbolRec = {
  key: string;
  path: string;
  symbol: string;
  container: string | null;
  startLine: number;
  endLine: number;
  /** Has a body a reader can start at (a function, method or callback-wrapped const; not a signature or a type). */
  callable: boolean;
  kind: SymbolKind;
  /** Node whose subtree is searched for calls. */
  body: Node | undefined;
  fn: FunctionLike | undefined;
  /** Enclosing class, for methods. */
  cls: ClassFacts | undefined;
  /** For object-literal members: the object literal (its `this`). */
  declaredReturn: TypeNode | undefined;
};

type MemberFact = { sym: SymbolRec | undefined; type: TypeNode | undefined; newOf: Expression | undefined; info?: TypeInfo | undefined };

type ClassFacts = {
  name: string;
  path: string;
  node: ClassDeclaration;
  abstract: boolean;
  members: Map<string, MemberFact>;
  extendsExpr: Expression | undefined;
  implementsExprs: readonly Expression[];
};
type InterfaceFacts = { name: string; path: string; node: InterfaceDeclaration; members: Map<string, MemberFact> };
type AliasFacts = { name: string; path: string; node: TypeAliasDeclaration; members: Map<string, MemberFact> | undefined };
type ValueFacts = { name: string; path: string; type: TypeNode | undefined; initializer: Expression | undefined; sym: SymbolRec | undefined; members: Map<string, SymbolRec> | undefined };

type Entity =
  | { k: "class"; cls: ClassFacts }
  | { k: "interface"; itf: InterfaceFacts }
  | { k: "alias"; alias: AliasFacts }
  | { k: "sym"; sym: SymbolRec }
  | { k: "value"; val: ValueFacts }
  | { k: "namespace"; path: string }
  | { k: "external"; module: string; name: string };

type ExportRef = { k: "local"; name: string } | { k: "from"; module: string; imported: string };
type FileFacts = {
  path: string;
  sf: SourceFile;
  lines: string[];
  imports: Map<string, { module: string; imported: string }>;
  exports: Map<string, ExportRef>;
  star: string[];
  top: Map<string, Entity>;
};

export type TypeInfo =
  | { k: "class"; cls: ClassFacts }
  | { k: "interface"; itf: InterfaceFacts }
  | { k: "object"; members: Map<string, MemberFact>; path: string; name: string }
  | { k: "moduleObject"; members: Map<string, SymbolRec>; name: string }
  | { k: "namespace"; path: string }
  | { k: "function"; node: FunctionLike; path: string }
  | { k: "external"; module: string; name: string };

const UTILITY_WRAPPERS = new Set(["Pick", "Omit", "Partial", "Required", "Readonly", "NonNullable", "Awaited", "Promise"]);

export type AstGraph = {
  root: string;
  declarations: GraphDeclaration[];
  /** Keys of declarations a reader can start at. */
  callable: Set<string>;
  edgesFrom: Map<string, FlowEdge[]>;
  /** Calls that leave the repository, per calling symbol, in source order. */
  externals: Map<string, ExternalCall[]>;
  /** Outermost request-shaped callables (the AST notion of an HTTP entry point). */
  entries: CodeSymbol[];
  stats: { files: number; declarations: number; edges: number; externalCalls: number; aliasResolved: string[]; parseMs: number; buildMs: number };
};
export type GraphDeclaration = { path: string; symbol: string; container: string | null; startLine: number; endLine: number };

export const keyOf = (d: { path: string; symbol: string; container: string | null }): string => `${d.path}#${d.container ?? ""}#${d.symbol}`;
const toSymbol = (s: SymbolRec): CodeSymbol => ({ path: s.path, symbol: s.symbol, container: s.container, startLine: s.startLine, endLine: s.endLine });

// ---------------------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------------------

export async function buildAstGraph(root: string, options: AstOptions = FULL_AST): Promise<AstGraph> {
  const t0 = performance.now();
  const index = indexRepository(root); // the product's own file set: same inputs for both engines
  const paths = [...index.files.keys()].sort();
  const project = mkdtempSync(join(tmpdir(), "ast-spike-"));
  const api = new API({ cwd: project });
  let facts: AstRepo;
  let parseMs = 0;
  try {
    writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, noResolve: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [], skipLibCheck: true }, files: paths.map((p) => join(root, p)) }));
    const snapshot = await api.updateSnapshot({ openProject: join(project, "tsconfig.json") });
    const compiled = snapshot.getProjects()[0];
    if (!compiled) throw new Error("typescript API returned no project");
    const files = new Map<string, SourceFile>();
    for (const path of paths) {
      const sf = await compiled.program.getSourceFile(join(root, path));
      if (sf) files.set(path, sf);
    }
    parseMs = performance.now() - t0;
    facts = new AstRepo(files, options);
    facts.collect();
  } finally {
    await api.close();
    rmSync(project, { recursive: true, force: true });
  }
  const t1 = performance.now();
  const graph = facts.analyze(root);
  graph.stats.parseMs = Math.round(parseMs);
  graph.stats.buildMs = Math.round(performance.now() - t1);
  return graph;
}

const unwrap = (e: Expression): Expression => {
  let current: Expression = e;
  for (;;) {
    if (isParenthesizedExpression(current) || isNonNullExpression(current) || isAwaitExpression(current) || isSatisfiesExpression(current)) current = current.expression;
    else return current;
  }
};

const nameText = (n: Node | undefined): string | null => (n && (isIdentifier(n) || isStringLiteral(n)) ? n.text : null);
const hasModifier = (n: Node, kind: SyntaxKind): boolean => ((n as { modifiers?: readonly Node[] }).modifiers ?? []).some((m) => m.kind === kind);
const entityRoot = (n: EntityName): string => (isQualifiedName(n) ? entityRoot(n.left) : n.text);
const entityLast = (n: EntityName): string => (isQualifiedName(n) ? n.right.text : n.text);

class AstRepo {
  private readonly byPath = new Map<string, FileFacts>();
  private readonly symbols: SymbolRec[] = [];
  private readonly classes: ClassFacts[] = [];
  private readonly factories: { sym: SymbolRec; returns: TypeNode; members: Map<string, SymbolRec> }[] = [];
  private readonly edgesFrom = new Map<string, FlowEdge[]>();
  private readonly externals = new Map<string, ExternalCall[]>();
  private readonly declarations: GraphDeclaration[] = [];
  private readonly aliasResolved: string[] = [];
  private readonly implCache = new Map<string, SymbolRec | null>();
  private readonly paths: string[];
  private readonly directories: Set<string>;
  /** `export default { a, b }`: members naming symbols declared elsewhere in the file, resolved once every file is collected. */
  private readonly pendingAlias: { members: Map<string, SymbolRec>; member: string; target: string; path: string }[] = [];

  constructor(files: Map<string, SourceFile>, private readonly opt: AstOptions) {
    for (const [path, sf] of files) this.byPath.set(path, { path, sf, lines: sf.text.split("\n"), imports: new Map(), exports: new Map(), star: [], top: new Map() });
    this.paths = [...files.keys()];
    this.directories = new Set(this.paths.flatMap((p) => p.split("/").slice(0, -1)));
  }

  // ---- phase 1: declarations, imports, exports -----------------------------------------------------------

  collect(): void {
    for (const file of this.byPath.values()) this.collectFile(file);
  }

  private lineOf(file: FileFacts, pos: number): number {
    return file.sf.getLineAndCharacterOfPosition(pos).line + 1;
  }

  private declare(file: FileFacts, node: Node, symbol: string, container: string | null): { startLine: number; endLine: number } {
    const startLine = this.lineOf(file, node.getStart());
    const endLine = this.lineOf(file, Math.max(node.getStart(), node.end - 1));
    this.declarations.push({ path: file.path, symbol, container, startLine, endLine });
    return { startLine, endLine };
  }

  private newSymbol(file: FileFacts, node: Node, symbol: string, container: string | null, kind: SymbolKind, body: Node | undefined, fn: FunctionLike | undefined, cls: ClassFacts | undefined, declare = true): SymbolRec {
    const { startLine, endLine } = declare ? this.declare(file, node, symbol, container) : { startLine: this.lineOf(file, node.getStart()), endLine: this.lineOf(file, Math.max(node.getStart(), node.end - 1)) };
    const sym: SymbolRec = { key: keyOf({ path: file.path, symbol, container }), path: file.path, symbol, container, startLine, endLine, callable: body !== undefined, kind, body, fn, cls, declaredReturn: fn?.type };
    this.symbols.push(sym);
    return sym;
  }

  private collectFile(file: FileFacts): void {
    for (const st of file.sf.statements) {
      if (isImportDeclaration(st)) {
        const module = isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
        const clause = st.importClause;
        if (!module || !clause) continue;
        if (clause.name) file.imports.set(clause.name.text, { module, imported: "default" });
        const bindings = clause.namedBindings;
        if (bindings && isNamespaceImport(bindings)) file.imports.set(bindings.name.text, { module, imported: "*" });
        else if (bindings && isNamedImports(bindings)) for (const el of bindings.elements) file.imports.set(el.name.text, { module, imported: nameText(el.propertyName) ?? el.name.text });
      } else if (isExportDeclaration(st)) {
        const module = st.moduleSpecifier && isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
        const clause = st.exportClause;
        if (clause && isNamedExports(clause)) {
          for (const el of clause.elements) {
            const exported = nameText(el.name) ?? "";
            const local = nameText(el.propertyName) ?? exported;
            file.exports.set(exported, module ? { k: "from", module, imported: local } : { k: "local", name: local });
          }
        } else if (!clause && module) file.star.push(module);
      } else if (isExportAssignment(st)) {
        const expr = unwrap(st.expression);
        if (isIdentifier(expr)) file.exports.set("default", { k: "local", name: expr.text });
        else this.collectValue(file, st, "default", undefined, expr, true);
      } else if (isFunctionDeclaration(st)) {
        const name = st.name?.text ?? "default";
        const sym = this.newSymbol(file, st, name, null, "function", st.body, st, undefined);
        file.top.set(name, { k: "sym", sym });
        this.exportModifiers(file, st, name);
        this.noteFactory(sym, st.type, st.body);
      } else if (isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) {
          const name = nameText(decl.name);
          if (!name) continue;
          this.collectValue(file, decl, name, decl.type, decl.initializer ? unwrap(decl.initializer) : undefined, false);
          this.exportModifiers(file, st, name);
        }
      } else if (isClassDeclaration(st)) {
        const cls = this.collectClass(file, st);
        if (cls) this.exportModifiers(file, st, cls.name);
      } else if (isInterfaceDeclaration(st)) {
        const itf: InterfaceFacts = { name: st.name.text, path: file.path, node: st, members: new Map() };
        this.declare(file, st, itf.name, null);
        this.collectTypeMembers(file, st.members, itf.name, itf.members);
        file.top.set(itf.name, { k: "interface", itf });
        this.exportModifiers(file, st, itf.name);
      } else if (isTypeAliasDeclaration(st)) {
        const alias: AliasFacts = { name: st.name.text, path: file.path, node: st, members: undefined };
        this.declare(file, st, alias.name, null);
        if (isTypeLiteralNode(st.type)) {
          alias.members = new Map();
          this.collectTypeMembers(file, st.type.members, alias.name, alias.members);
        }
        file.top.set(alias.name, { k: "alias", alias });
        this.exportModifiers(file, st, alias.name);
      } else if (isEnumDeclaration(st)) {
        this.declare(file, st, st.name.text, null);
      }
    }
  }

  private exportModifiers(file: FileFacts, node: Node, name: string): void {
    if (!hasModifier(node, SyntaxKind.ExportKeyword)) return;
    file.exports.set(name, { k: "local", name });
    if (hasModifier(node, SyntaxKind.DefaultKeyword)) file.exports.set("default", { k: "local", name });
  }

  /** A function directly declared with an interface return type that returns an object literal implements it. */
  private noteFactory(sym: SymbolRec, returns: TypeNode | undefined, body: Node | undefined): void {
    if (!this.opt.objectFactories || !returns || !body) return;
    const literal = this.returnedObjectLiteral(body);
    if (!literal) return;
    const file = this.byPath.get(sym.path)!;
    const members = new Map<string, SymbolRec>();
    for (const prop of literal.properties) {
      const name = nameText((prop as { name?: Node }).name);
      if (!name) continue;
      if (isMethodDeclaration(prop)) members.set(name, this.newSymbol(file, prop, name, sym.symbol, "object-member", prop.body, prop, undefined));
      else if (isPropertyAssignment(prop)) {
        const init = unwrap(prop.initializer);
        if (isArrowFunction(init) || isFunctionExpression(init)) members.set(name, this.newSymbol(file, prop, name, sym.symbol, "object-member", init.body, init, undefined));
      }
    }
    if (members.size) this.factories.push({ sym, returns, members });
  }

  private returnedObjectLiteral(body: Node): ObjectLiteralExpression | undefined {
    const direct = isObjectLiteralExpression(body) ? body : isParenthesizedExpression(body) && isObjectLiteralExpression(unwrap(body)) ? (unwrap(body) as ObjectLiteralExpression) : undefined;
    if (direct) return direct;
    let found: ObjectLiteralExpression | undefined;
    const visit = (n: Node): undefined => {
      if (found) return undefined;
      if (isReturnStatement(n) && n.expression) {
        const e = unwrap(n.expression);
        if (isObjectLiteralExpression(e)) {
          found = e;
          return undefined;
        }
      }
      if (isFunctionDeclaration(n) || isArrowFunction(n) || isFunctionExpression(n) || isClassDeclaration(n)) return undefined; // nested function: its returns are not ours
      n.forEachChild(visit);
      return undefined;
    };
    body.forEachChild(visit);
    return found;
  }

  /** A function-like node, or a call that hands one (possibly through a nested call) to something: `catchAsync(async (req, res) => …)`. */
  private functionIn(e: Expression, depth = 0): FunctionLike | undefined {
    if (isArrowFunction(e) || isFunctionExpression(e)) return e;
    if (isCallExpression(e) && depth < 3) {
      for (const arg of e.arguments) {
        const found = this.functionIn(unwrap(arg), depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  private collectValue(file: FileFacts, node: Node, name: string, type: TypeNode | undefined, init: Expression | undefined, isDefault: boolean): void {
    const val: ValueFacts = { name, path: file.path, type, initializer: init, sym: undefined, members: undefined };
    if (init && (isArrowFunction(init) || isFunctionExpression(init))) {
      val.sym = this.newSymbol(file, node, name, null, "function", init.body, init, undefined);
      this.noteFactory(val.sym, init.type, init.body);
    } else if (init && isCallExpression(init) && this.functionIn(init)) {
      // A const initialised by a call that receives an inline function: the function is where the work is.
      val.sym = this.newSymbol(file, node, name, null, "function", init, this.functionIn(init), undefined);
    } else if (init && isObjectLiteralExpression(init) && this.opt.moduleObjects) {
      val.members = new Map();
      this.declare(file, node, name, null);
      for (const prop of init.properties) {
        const member = nameText((prop as { name?: Node }).name);
        if (!member) continue;
        if (isMethodDeclaration(prop)) val.members.set(member, this.newSymbol(file, prop, member, name, "object-member", prop.body, prop, undefined));
        else if (isPropertyAssignment(prop)) {
          const value = unwrap(prop.initializer);
          if (isArrowFunction(value) || isFunctionExpression(value)) val.members.set(member, this.newSymbol(file, prop, member, name, "object-member", value.body, value, undefined));
          else if (isIdentifier(value)) this.pendingAlias.push({ members: val.members, member, target: value.text, path: file.path });
        } else if (isShorthandPropertyAssignment(prop)) this.pendingAlias.push({ members: val.members, member, target: nameText(prop.name) ?? "", path: file.path });
      }
    } else this.declare(file, node, name, null);
    file.top.set(name, { k: "value", val });
    if (isDefault) file.exports.set("default", { k: "local", name });
  }

  private collectClass(file: FileFacts, node: ClassDeclaration): ClassFacts | undefined {
    const name = node.name?.text ?? "default";
    const heritage = node.heritageClauses ?? [];
    const ext = heritage.find((h) => h.token === SyntaxKind.ExtendsKeyword)?.types[0];
    const impl = heritage.filter((h) => h.token === SyntaxKind.ImplementsKeyword).flatMap((h) => [...h.types]);
    const cls: ClassFacts = {
      name,
      path: file.path,
      node,
      abstract: hasModifier(node, SyntaxKind.AbstractKeyword),
      members: new Map(),
      extendsExpr: ext?.expression,
      implementsExprs: impl.map((t) => t.expression),
    };
    this.declare(file, node, name, null);
    for (const member of node.members) {
      if (isConstructorDeclaration(member)) {
        for (const p of member.parameters) {
          const pname = nameText(p.name);
          if (pname && ((p as { modifiers?: readonly Node[] }).modifiers ?? []).some((m) => m.kind !== SyntaxKind.Decorator)) cls.members.set(pname, { sym: undefined, type: p.type, newOf: undefined });
        }
        // `this.x = param` in the constructor body gives field x the parameter's declared type.
        const paramTypes = new Map(member.parameters.flatMap((p) => (nameText(p.name) && p.type ? ([[nameText(p.name)!, p.type]] as const) : [])));
        const visit = (n: Node): undefined => {
          if (isBinaryExpression(n) && n.operatorToken.kind === SyntaxKind.EqualsToken && isPropertyAccessExpression(n.left) && n.left.expression.kind === SyntaxKind.ThisKeyword && isIdentifier(n.right)) {
            const field = n.left.name.text;
            const type = paramTypes.get(n.right.text);
            if (type && !cls.members.get(field)?.type) cls.members.set(field, { sym: cls.members.get(field)?.sym, type, newOf: undefined });
          }
          n.forEachChild(visit);
          return undefined;
        };
        member.body?.forEachChild(visit);
      } else if (isMethodDeclaration(member)) {
        const mname = nameText(member.name);
        if (!mname) continue;
        const kind = hasModifier(member, SyntaxKind.AbstractKeyword) ? "interface-member" : "method";
        const sym = this.newSymbol(file, member, mname, name, kind, member.body, member, cls);
        cls.members.set(mname, { sym, type: undefined, newOf: undefined });
      } else if (isPropertyDeclaration(member)) {
        const pname = nameText(member.name);
        if (!pname) continue;
        const init = member.initializer ? unwrap(member.initializer) : undefined;
        if (init && (isArrowFunction(init) || isFunctionExpression(init))) {
          const sym = this.newSymbol(file, member, pname, name, "method", init.body, init, cls);
          cls.members.set(pname, { sym, type: member.type, newOf: undefined });
        } else cls.members.set(pname, { sym: undefined, type: member.type, newOf: init && isNewExpression(init) ? init.expression : undefined });
      }
    }
    file.top.set(name, { k: "class", cls });
    if (hasModifier(node, SyntaxKind.DefaultKeyword)) file.exports.set("default", { k: "local", name });
    this.classes.push(cls);
    return cls;
  }

  private collectTypeMembers(file: FileFacts, members: readonly TypeElement[], container: string, into: Map<string, MemberFact>): void {
    for (const m of members) {
      const name = nameText((m as { name?: Node }).name);
      if (!name) continue;
      if (isMethodSignatureDeclaration(m)) {
        const sym = this.newSymbol(file, m, name, container, "interface-member", undefined, m, undefined);
        into.set(name, { sym, type: undefined, newOf: undefined });
      } else if (isPropertySignatureDeclaration(m)) {
        const fnType = m.type && isFunctionTypeNode(m.type) ? m.type : undefined;
        const sym = fnType ? this.newSymbol(file, m, name, container, "interface-member", undefined, fnType, undefined) : undefined;
        into.set(name, { sym, type: m.type, newOf: undefined });
      }
    }
  }

  // ---- name, module and type resolution ---------------------------------------------------------------------

  resolveModule(from: string, spec: string): string | "external" {
    const norm = (p: string): string => {
      const out: string[] = [];
      for (const part of p.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
      }
      return out.join("/");
    };
    const tries = (base: string): string | undefined => [base, `${base}.ts`, `${base.replace(/\.js$/, "")}.ts`, `${base}/index.ts`].find((c) => this.byPath.has(c));
    if (spec.startsWith(".")) {
      const dir = from.split("/").slice(0, -1).join("/");
      return tries(norm(`${dir}/${spec}`)) ?? "external";
    }
    if (!this.opt.aliasImports || !spec.includes("/")) return "external";
    const segments = spec.split("/");
    // An alias names a directory of the repository (`@domain/x` -> .../domain/x) or the source root (`@/x`, `~/x`).
    // A package scope (`@prisma/client`) that merely shares a file name with the repository is NOT an alias.
    const head = segments[0]!;
    if (head !== "@" && head !== "~" && !this.directories.has(head.replace(/^[@~]/, ""))) return "external";
    for (const tail of [segments.join("/"), `${head.replace(/^[@~]/, "")}/${segments.slice(1).join("/")}`, segments.slice(1).join("/")]) {
      if (!tail) continue;
      const hits = this.paths.filter((p) => p === `${tail}.ts` || p.endsWith(`/${tail}.ts`) || p === `${tail}/index.ts` || p.endsWith(`/${tail}/index.ts`));
      if (hits.length === 1) {
        this.aliasResolved.push(`${from} :: ${spec} -> ${hits[0]}`);
        return hits[0]!;
      }
    }
    return "external";
  }

  private resolveExport(path: string, name: string, seen = new Set<string>()): Entity | null {
    const marker = `${path}::${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const file = this.byPath.get(path);
    if (!file) return null;
    const ref = file.exports.get(name);
    if (ref?.k === "local") return file.top.get(ref.name) ?? this.resolveName(path, ref.name, seen);
    if (ref?.k === "from") return this.viaModule(path, ref.module, ref.imported, seen);
    if (name !== "default") {
      const own = file.top.get(name);
      if (own && file.exports.has(name)) return own;
    }
    for (const module of file.star) {
      const found = this.viaModule(path, module, name, seen);
      if (found && found.k !== "external") return found;
    }
    return null;
  }

  private viaModule(from: string, module: string, imported: string, seen: Set<string>): Entity | null {
    const target = this.resolveModule(from, module);
    if (target === "external") return { k: "external", module, name: imported };
    if (imported === "*") return { k: "namespace", path: target };
    return this.resolveExport(target, imported, seen);
  }

  resolveName(path: string, name: string, seen = new Set<string>()): Entity | null {
    const file = this.byPath.get(path);
    if (!file) return null;
    const own = file.top.get(name);
    if (own) return own;
    const imp = file.imports.get(name);
    return imp ? this.viaModule(path, imp.module, imp.imported, seen) : null;
  }

  /** A declared type node -> what it denotes. `unwrapPromise` is for return types: `Promise<X>` is X to the caller that awaits. */
  typeOf(node: TypeNode | undefined, path: string, depth = 0): TypeInfo | null {
    if (!node || depth > 6) return null;
    if (isParenthesizedTypeNode(node)) return this.typeOf(node.type, path, depth + 1);
    if (isFunctionTypeNode(node)) return { k: "function", node, path };
    if (isTypeLiteralNode(node)) {
      const members = new Map<string, MemberFact>();
      const file = this.byPath.get(path);
      if (file) {
        for (const m of node.members) {
          const name = nameText((m as { name?: Node }).name);
          if (name && isPropertySignatureDeclaration(m)) members.set(name, { sym: undefined, type: m.type, newOf: undefined });
        }
      }
      return { k: "object", members, path, name: "{…}" };
    }
    if (isUnionTypeNode(node)) {
      const absent = (t: TypeNode): boolean => [SyntaxKind.UndefinedKeyword, SyntaxKind.VoidKeyword, SyntaxKind.NeverKeyword].includes(t.kind) || (isLiteralTypeNode(t) && t.literal.kind === SyntaxKind.NullKeyword);
      const real = node.types.filter((t) => !absent(t));
      return real.length === 1 ? this.typeOf(real[0], path, depth + 1) : null;
    }
    if (!isTypeReferenceNode(node)) return null;
    const name = entityLast(node.typeName);
    const first = entityRoot(node.typeName);
    const query = node.typeArguments?.[0];
    if (this.opt.inferReturns && !isQualifiedName(node.typeName) && name === "ReturnType" && query && isTypeQueryNode(query)) return this.inferredReturn(query.exprName, path, depth);
    if (!isQualifiedName(node.typeName) && UTILITY_WRAPPERS.has(name) && node.typeArguments?.length) return this.typeOf(node.typeArguments[0], path, depth + 1);
    const entity = this.resolveName(path, first);
    if (!entity) return null;
    return this.entityType(entity, isQualifiedName(node.typeName) ? name : undefined, depth);
  }

  private entityType(entity: Entity, qualified: string | undefined, depth: number): TypeInfo | null {
    switch (entity.k) {
      case "class": return qualified ? null : { k: "class", cls: entity.cls };
      case "interface": return qualified ? null : { k: "interface", itf: entity.itf };
      case "external": return { k: "external", module: entity.module, name: qualified ?? entity.name };
      case "namespace": {
        if (!qualified) return null;
        const inner = this.resolveExport(entity.path, qualified);
        return inner ? this.entityType(inner, undefined, depth + 1) : null;
      }
      case "alias": {
        if (entity.alias.members) return { k: "object", members: entity.alias.members, path: entity.alias.path, name: entity.alias.name };
        return this.typeOf(entity.alias.node.type, entity.alias.path, depth + 1);
      }
      default: return null;
    }
  }

  private inferredReturn(expr: EntityName, path: string, depth: number): TypeInfo | null {
    if (isQualifiedName(expr)) return null;
    const entity = this.resolveName(path, expr.text);
    const sym = entity?.k === "sym" ? entity.sym : entity?.k === "value" ? entity.val.sym : undefined;
    if (!sym?.body) return null;
    if (sym.declaredReturn) return this.typeOf(sym.declaredReturn, sym.path, depth + 1);
    const literal = this.returnedObjectLiteral(sym.body);
    if (!literal) return null;
    const env = new Map<string, TypeInfo>();
    for (const p of sym.fn?.parameters ?? []) this.bindParameter(p, sym.path, env, undefined);
    const visit = (n: Node): undefined => {
      if (isArrowFunction(n) || isFunctionExpression(n) || isFunctionDeclaration(n) || isClassDeclaration(n)) return undefined;
      if (isVariableDeclaration(n)) this.bindLocal(n, sym.path, env, undefined);
      n.forEachChild(visit);
      return undefined;
    };
    sym.body.forEachChild(visit);
    return this.objectTypeOfLiteral(literal, sym.path, env, depth + 1);
  }

  private objectTypeOfLiteral(literal: ObjectLiteralExpression, path: string, env: Map<string, TypeInfo>, depth: number): TypeInfo {
    const members = new Map<string, MemberFact>();
    for (const prop of literal.properties) {
      const name = nameText((prop as { name?: Node }).name);
      if (!name) continue;
      let info: TypeInfo | null = null;
      if (isShorthandPropertyAssignment(prop)) info = env.get(name) ?? null;
      else if (isPropertyAssignment(prop)) {
        const init = unwrap(prop.initializer);
        info = isObjectLiteralExpression(init) ? this.objectTypeOfLiteral(init, path, env, depth + 1) : this.typeOfExpr(init, path, env, undefined, depth + 1);
      }
      if (info) members.set(name, { sym: undefined, type: undefined, newOf: undefined, info });
    }
    return { k: "object", members, path, name: "{inferred}" };
  }

  // ---- members -------------------------------------------------------------------------------------------------

  private heritageClass(cls: ClassFacts): Entity | null {
    if (!cls.extendsExpr) return null;
    const e = unwrap(cls.extendsExpr);
    return isIdentifier(e) ? this.resolveName(cls.path, e.text) : null;
  }

  private heritageInterfaces(itf: InterfaceFacts): (Entity | null)[] {
    return (itf.node.heritageClauses ?? []).flatMap((h) => [...h.types]).map((t) => (isIdentifier(t.expression) ? this.resolveName(itf.path, t.expression.text) : null));
  }

  /** The member `name` of a type: its declared type and/or callable symbol; or the external base it is inherited from. */
  member(ti: TypeInfo, name: string, depth = 0): { fact: MemberFact; path: string } | { external: { module: string; name: string } } | null {
    if (depth > 8) return null;
    if (ti.k === "class") {
      const own = ti.cls.members.get(name);
      if (own) return { fact: own, path: ti.cls.path };
      if (!this.opt.inheritance) return null;
      const parent = this.heritageClass(ti.cls);
      if (!parent) return null;
      if (parent.k === "external") return { external: { module: parent.module, name: parent.name } };
      return parent.k === "class" ? this.member({ k: "class", cls: parent.cls }, name, depth + 1) : null;
    }
    if (ti.k === "interface") {
      const own = ti.itf.members.get(name);
      if (own) return { fact: own, path: ti.itf.path };
      if (!this.opt.inheritance) return null;
      for (const parent of this.heritageInterfaces(ti.itf)) {
        if (parent?.k !== "interface") continue;
        const found = this.member({ k: "interface", itf: parent.itf }, name, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (ti.k === "object") {
      const own = ti.members.get(name);
      return own ? { fact: own, path: ti.path } : null;
    }
    if (ti.k === "moduleObject") {
      const sym = ti.members.get(name);
      return sym ? { fact: { sym, type: undefined, newOf: undefined }, path: sym.path } : null;
    }
    if (ti.k === "namespace") {
      const entity = this.resolveExport(ti.path, name);
      if (entity?.k === "sym") return { fact: { sym: entity.sym, type: undefined, newOf: undefined }, path: ti.path };
      if (entity?.k === "value") return { fact: { sym: entity.val.sym, type: entity.val.type, newOf: undefined }, path: ti.path };
      return null;
    }
    return null;
  }

  private memberTypeInfo(found: { fact: MemberFact; path: string }): TypeInfo | null {
    if (found.fact.info) return found.fact.info;
    if (found.fact.type) return this.typeOf(found.fact.type, found.path);
    if (found.fact.newOf && isIdentifier(found.fact.newOf)) {
      const entity = this.resolveName(found.path, found.fact.newOf.text);
      return entity ? this.entityType(entity, undefined, 0) : null;
    }
    return null;
  }

  // ---- expression typing (DECLARED types only) -----------------------------------------------------------

  private valueType(val: ValueFacts): TypeInfo | null {
    if (val.type) return this.typeOf(val.type, val.path);
    if (val.members) return { k: "moduleObject", members: val.members, name: val.name };
    return val.initializer ? this.typeOfExpr(val.initializer, val.path, new Map(), undefined, 0) : null;
  }

  private typeOfExpr(e0: Expression, path: string, env: Map<string, TypeInfo>, self: TypeInfo | undefined, depth: number): TypeInfo | null {
    if (depth > 6) return null;
    const e = unwrap(e0);
    if (isAsExpression(e) || isTypeAssertion(e)) return this.typeOf(e.type, path, depth);
    if (e.kind === SyntaxKind.ThisKeyword) return self ?? null;
    if (isIdentifier(e)) {
      const local = env.get(e.text);
      if (local) return local;
      const entity = this.resolveName(path, e.text);
      if (!entity) return null;
      if (entity.k === "value") return this.valueType(entity.val);
      if (entity.k === "class") return { k: "class", cls: entity.cls };
      if (entity.k === "external") return { k: "external", module: entity.module, name: entity.name };
      if (entity.k === "namespace") return { k: "namespace", path: entity.path };
      return null;
    }
    if (isNewExpression(e)) {
      const ctor = unwrap(e.expression);
      if (!isIdentifier(ctor)) return null;
      const entity = this.resolveName(path, ctor.text);
      return entity ? this.entityType(entity, undefined, depth) : null;
    }
    if (isPropertyAccessExpression(e)) {
      const base = this.typeOfExpr(e.expression, path, env, self, depth + 1);
      if (!base) return null;
      if (base.k === "external") return { k: "external", module: base.module, name: base.name };
      const found = this.member(base, e.name.text);
      if (!found) return null;
      if ("external" in found) return { k: "external", module: found.external.module, name: found.external.name };
      return this.memberTypeInfo(found);
    }
    if (isCallExpression(e) && this.opt.returnTypes) {
      const target = this.resolveCallTarget(e, path, env, self, depth + 1);
      if (target?.sym?.declaredReturn) return this.typeOf(target.sym.declaredReturn, target.sym.path, depth + 1);
    }
    return null;
  }

  // ---- phase 2: edges ------------------------------------------------------------------------------------------

  /** Resolves a call to the repository symbol it provably invokes (declared types only), or to nothing. */
  private resolveCallTarget(call: CallExpression, path: string, env: Map<string, TypeInfo>, self: TypeInfo | undefined, depth: number): { sym?: SymbolRec; external?: ExternalCall["module"] } | null {
    const callee = unwrap(call.expression);
    if (isIdentifier(callee)) {
      if (env.has(callee.text)) return null;
      const entity = this.resolveName(path, callee.text);
      if (entity?.k === "sym") return { sym: entity.sym };
      if (entity?.k === "value" && entity.val.sym) return { sym: entity.val.sym };
      return null;
    }
    if (!isPropertyAccessExpression(callee)) return null;
    const base = this.typeOfExpr(callee.expression, path, env, self, depth);
    if (!base || base.k === "external") return null;
    const found = this.member(base, callee.name.text);
    return found && "fact" in found && found.fact.sym ? { sym: found.fact.sym } : null;
  }

  private snippet(file: FileFacts, pos: number): string {
    return (file.lines[this.lineOf(file, pos) - 1] ?? "").trim();
  }

  private pushEdge(edge: FlowEdge): void {
    const key = keyOf(edge.from);
    const list = this.edgesFrom.get(key) ?? [];
    if (!list.some((e) => keyOf(e.to) === keyOf(edge.to))) list.push(edge);
    this.edgesFrom.set(key, list);
  }

  /** The ONE concrete implementation of an interface member, when the pinned source has exactly one. */
  private implementationOf(member: SymbolRec): SymbolRec | null {
    if (this.implCache.has(member.key)) return this.implCache.get(member.key)!;
    const container = member.container;
    const itf = container ? this.interfaceNamed(member.path, container) : undefined;
    const contract = container ? this.abstractClassNamed(member.path, container) : undefined;
    let result: SymbolRec | null = null;
    if (contract) {
      const candidates: SymbolRec[] = [];
      for (const cls of this.classes) {
        if (cls.abstract || !this.derivesFrom(cls, contract)) continue;
        const found = this.member({ k: "class", cls }, member.symbol);
        if (found && "fact" in found && found.fact.sym?.callable) candidates.push(found.fact.sym);
      }
      if (new Set(candidates.map((c) => c.key)).size === 1) result = candidates[0]!;
    } else if (itf) {
      const candidates: SymbolRec[] = [];
      const targets = this.interfaceClosure(itf);
      for (const cls of this.classes) {
        if (cls.abstract || !this.classImplements(cls, targets)) continue;
        const found = this.member({ k: "class", cls }, member.symbol);
        if (found && "fact" in found && found.fact.sym?.callable) candidates.push(found.fact.sym);
      }
      for (const factory of this.factories) {
        const ret = this.typeOf(factory.returns, factory.sym.path);
        const impl = factory.members.get(member.symbol);
        if (ret && impl && (ret.k === "interface" ? targets.has(ret.itf) : false)) candidates.push(impl);
      }
      const unique = new Set(candidates.map((c) => c.key));
      if (unique.size === 1) result = candidates[0]!;
    }
    this.implCache.set(member.key, result);
    return result;
  }

  private abstractClassNamed(path: string, name: string): ClassFacts | undefined {
    const e = this.byPath.get(path)?.top.get(name);
    return e?.k === "class" && e.cls.abstract ? e.cls : undefined;
  }

  /** `cls` extends `base` (through any chain) or lists it in `implements`. */
  private derivesFrom(cls: ClassFacts, base: ClassFacts, depth = 0): boolean {
    if (depth > 6) return false;
    const heritage = this.heritageClass(cls);
    if (heritage?.k === "class" && (heritage.cls === base || this.derivesFrom(heritage.cls, base, depth + 1))) return true;
    return cls.implementsExprs.some((expr) => {
      const entity = isIdentifier(expr) ? this.resolveName(cls.path, expr.text) : null;
      return entity?.k === "class" && entity.cls === base;
    });
  }

  private interfaceNamed(path: string, name: string): InterfaceFacts | undefined {
    const e = this.byPath.get(path)?.top.get(name);
    return e?.k === "interface" ? e.itf : undefined;
  }

  /** The interface itself plus every interface it extends (a class implementing a child implements the parent). */
  private interfaceClosure(itf: InterfaceFacts): Set<InterfaceFacts> {
    const out = new Set<InterfaceFacts>();
    const visit = (i: InterfaceFacts): void => {
      if (out.has(i)) return;
      out.add(i);
      for (const p of this.heritageInterfaces(i)) if (p?.k === "interface") visit(p.itf);
    };
    visit(itf);
    return out;
  }

  /** `targets` is the set {I} that a call was declared against; does `cls` (or an ancestor) implement I or any interface that extends I? */
  private classImplements(cls: ClassFacts, targets: Set<InterfaceFacts>, depth = 0): boolean {
    if (depth > 6) return false;
    const wanted = [...targets][0];
    for (const expr of cls.implementsExprs) {
      const entity = isIdentifier(expr) ? this.resolveName(cls.path, expr.text) : null;
      if (entity?.k === "interface" && wanted && this.interfaceClosure(entity.itf).has(wanted)) return true;
    }
    const parent = this.opt.inheritance ? this.heritageClass(cls) : null;
    return parent?.k === "class" ? this.classImplements(parent.cls, targets, depth + 1) : false;
  }

  private externalOf(file: FileFacts, sym: SymbolRec, node: Node, receiver: string[], members: string[], module: string, base: string, args: string): ExternalCall {
    return {
      from: toSymbol(sym),
      line: this.lineOf(file, node.getStart()),
      snippet: this.snippet(file, node.getStart()),
      argsText: args,
      signature: (file.lines[sym.startLine - 1] ?? "").trim(),
      receiver,
      dependency: base,
      base,
      module,
      members,
    };
  }

  private argsText(file: FileFacts, call: CallExpression): string {
    return call.arguments.length ? file.sf.text.slice(call.arguments.pos, call.arguments.end) : "";
  }

  private contextualParams(target: SymbolRec | undefined, call: CallExpression, env: Map<string, TypeInfo>): void {
    if (!this.opt.callbackParams || !target?.fn) return;
    call.arguments.forEach((arg, i) => {
      const cb = unwrap(arg);
      if (!isArrowFunction(cb) && !isFunctionExpression(cb)) return;
      const declared = target.fn!.parameters[i]?.type;
      const fnType = declared ? this.typeOf(declared, target.path) : null;
      if (fnType?.k !== "function") return;
      cb.parameters.forEach((p, j) => {
        const pname = nameText(p.name);
        const declaredParam = fnType.node.parameters[j]?.type;
        if (pname && !p.type && declaredParam) {
          const type = this.typeOf(declaredParam, fnType.path);
          if (type) env.set(pname, type);
        }
      });
    });
  }

  private bindParameter(p: ParameterDeclaration, path: string, env: Map<string, TypeInfo>, self: TypeInfo | undefined): void {
    const type = p.type ? this.typeOf(p.type, path) : null;
    const pname = nameText(p.name);
    if (pname && type) env.set(pname, type);
    if (isObjectBindingPattern(p.name) && type) {
      for (const el of p.name.elements) {
        const local = nameText(el.name);
        const prop = nameText(el.propertyName) ?? local;
        if (!local || !prop) continue;
        const found = this.member(type, prop);
        const t = found && "fact" in found ? this.memberTypeInfo(found) : null;
        if (t) env.set(local, t);
      }
    }
    void self;
  }

  private analyzeSymbol(sym: SymbolRec): void {
    if (!sym.body) return;
    const file = this.byPath.get(sym.path)!;
    const self: TypeInfo | undefined = sym.cls ? { k: "class", cls: sym.cls } : this.objectSelf(sym);
    const env = new Map<string, TypeInfo>();
    for (const p of sym.fn?.parameters ?? []) this.bindParameter(p, sym.path, env, self);
    const visit = (n: Node): undefined => {
      if ((isArrowFunction(n) || isFunctionExpression(n) || isMethodDeclaration(n)) && n !== sym.fn) for (const p of n.parameters) this.bindParameter(p, sym.path, env, self);
      if (isVariableDeclaration(n)) this.bindLocal(n, sym.path, env, self);
      if (isCallExpression(n)) this.handleCall(file, sym, n, env, self);
      n.forEachChild(visit);
      return undefined;
    };
    sym.body.forEachChild(visit);
    if (isCallExpression(sym.body)) this.handleCall(file, sym, sym.body, env, self); // wrapped const: the call itself is the body root
  }

  private objectSelf(sym: SymbolRec): TypeInfo | undefined {
    if (sym.kind !== "object-member" || !sym.container) return undefined;
    const top = this.byPath.get(sym.path)?.top.get(sym.container);
    return top?.k === "value" && top.val.members ? { k: "moduleObject", members: top.val.members, name: sym.container } : undefined;
  }

  private bindLocal(decl: { readonly name: Node; readonly type?: TypeNode | undefined; readonly initializer?: Expression | undefined }, path: string, env: Map<string, TypeInfo>, self: TypeInfo | undefined): void {
    const declared = decl.type ? this.typeOf(decl.type, path) : null;
    const type = declared ?? (decl.initializer ? this.typeOfExpr(decl.initializer, path, env, self, 0) : null);
    const lname = nameText(decl.name);
    if (lname && type) env.set(lname, type);
    if (isObjectBindingPattern(decl.name) && type) {
      for (const el of decl.name.elements) {
        const local = nameText(el.name);
        const prop = nameText(el.propertyName) ?? local;
        if (!local || !prop) continue;
        const found = this.member(type, prop);
        const t = found && "fact" in found ? this.memberTypeInfo(found) : null;
        if (t) env.set(local, t);
      }
    }
  }

  private handleCall(file: FileFacts, sym: SymbolRec, call: CallExpression, env: Map<string, TypeInfo>, self: TypeInfo | undefined): void {
    const callee = unwrap(call.expression);
    const at = call.getStart();
    const edge = (to: SymbolRec, kind: EdgeKind): void =>
      this.pushEdge({ from: toSymbol(sym), to: toSymbol(to), line: this.lineOf(file, at), snippet: this.snippet(file, at), kind, argsText: this.argsText(file, call) });
    const callInto = (to: SymbolRec): void => {
      if (to.key === sym.key) return;
      edge(to, "call");
      this.contextualParams(to, call, env);
      if (to.kind === "interface-member") {
        const impl = this.implementationOf(to);
        if (impl) this.pushEdge({ from: toSymbol(to), to: toSymbol(impl), line: impl.startLine, snippet: `implements ${to.container}`, kind: "implements", argsText: "" });
      }
    };
    const external = (receiver: string[], members: string[], module: string, base: string): void => {
      const list = this.externals.get(sym.key) ?? [];
      list.push(this.externalOf(file, sym, call, receiver, members, module, base, this.argsText(file, call)));
      this.externals.set(sym.key, list);
    };

    if (isIdentifier(callee)) {
      if (env.has(callee.text)) return;
      const entity = this.resolveName(sym.path, callee.text);
      if (entity?.k === "sym") callInto(entity.sym);
      else if (entity?.k === "value" && entity.val.sym) callInto(entity.val.sym);
      else if (entity?.k === "external") external([], [callee.text], entity.module, entity.name);
      return;
    }
    if (!isPropertyAccessExpression(callee)) return;

    const segments: string[] = [];
    let node: Expression = callee;
    while (isPropertyAccessExpression(node)) {
      segments.unshift(node.name.text);
      node = unwrap(node.expression);
    }
    const rootText = isIdentifier(node) ? node.text : node.kind === SyntaxKind.ThisKeyword ? "this" : node.kind === SyntaxKind.SuperKeyword ? "super" : "…";
    let current: TypeInfo | null;
    if (node.kind === SyntaxKind.SuperKeyword) {
      const parent = sym.cls ? this.heritageClass(sym.cls) : null;
      current = parent?.k === "class" ? { k: "class", cls: parent.cls } : parent?.k === "external" ? { k: "external", module: parent.module, name: parent.name } : null;
    } else current = this.typeOfExpr(node, sym.path, env, self, 0);
    const receiver = [rootText, ...segments.slice(0, -1)];

    for (let i = 0; i < segments.length && current; i++) {
      const seg = segments[i]!;
      if (current.k === "external") return external(receiver, segments.slice(i), current.module, current.name);
      const found = this.member(current, seg);
      if (!found) return;
      if ("external" in found) return external(receiver, segments.slice(i), found.external.module, found.external.name);
      if (i === segments.length - 1) {
        if (found.fact.sym) callInto(found.fact.sym);
        return;
      }
      current = this.memberTypeInfo(found);
    }
  }

  analyze(root: string): AstGraph {
    for (const p of this.pendingAlias.splice(0)) {
      const entity = this.resolveName(p.path, p.target);
      const target = entity?.k === "sym" ? entity.sym : entity?.k === "value" ? entity.val.sym : undefined;
      if (target) p.members.set(p.member, target);
    }
    const analyzed = new Set<string>();
    for (const sym of this.symbols) {
      if (!sym.body || analyzed.has(sym.key)) continue; // an overload signature has no body; its implementation is analysed under the same key
      analyzed.add(sym.key);
      this.analyzeSymbol(sym);
    }
    const callable = new Set(this.symbols.filter((s) => s.callable && s.kind !== "interface-member").map((s) => s.key));
    return {
      root,
      declarations: this.declarations,
      callable,
      edgesFrom: this.edgesFrom,
      externals: this.externals,
      entries: this.entries(),
      stats: { files: this.byPath.size, declarations: this.declarations.length, edges: [...this.edgesFrom.values()].reduce((n, l) => n + l.length, 0), externalCalls: [...this.externals.values()].reduce((n, l) => n + l.length, 0), aliasResolved: this.aliasResolved, parseMs: 0, buildMs: 0 },
    };
  }

  // ---- entry points ----------------------------------------------------------------------------------------------

  private requestShaped(p: ParameterDeclaration | undefined): boolean {
    if (!p) return false;
    const type = p.type && isTypeReferenceNode(p.type) ? entityLast(p.type.typeName) : "";
    const name = nameText(p.name) ?? "";
    return /(?:^|[a-z])Request$|^Req$/.test(type) || /^req(uest)?\d*$/i.test(name);
  }

  private entries(): CodeSymbol[] {
    if (!this.opt.entryHeuristic) return [];
    const shaped = new Set<string>();
    for (const sym of this.symbols) {
      if (!sym.callable || sym.kind === "interface-member" || !sym.body) continue;
      let hit = this.requestShaped(sym.fn?.parameters[0]);
      if (!hit) {
        // An inline closure that receives the request: `Bun.serve({ fetch(req) {} })`, `route({ handler: async (request, reply) => … })`.
        const visit = (n: Node): undefined => {
          if (hit) return undefined;
          if ((isArrowFunction(n) || isFunctionExpression(n) || isMethodDeclaration(n)) && this.requestShaped(n.parameters[0])) {
            hit = true;
            return undefined;
          }
          n.forEachChild(visit);
          return undefined;
        };
        sym.body.forEachChild(visit);
      }
      if (hit) shaped.add(sym.key);
    }
    // A request-shaped helper called by another request-shaped callable is internal, not an entry.
    const called = new Set<string>();
    for (const key of shaped) for (const e of this.edgesFrom.get(key) ?? []) if (shaped.has(keyOf(e.to)) && keyOf(e.to) !== key) called.add(keyOf(e.to));
    return this.symbols.filter((s) => shaped.has(s.key) && !called.has(s.key)).map(toSymbol);
  }
}

