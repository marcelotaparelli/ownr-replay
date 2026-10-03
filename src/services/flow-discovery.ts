import type { LearningGoalKind } from "../domain/learning-goal.ts";
import type { Declaration, RepositoryIndex } from "./code-map.ts";

/**
 * Discovers a minimal, verified call chain from a real HTTP entry point to a symbol relevant
 * to a free-text technical goal — using only static analysis of the pinned source (no per-goal
 * recipes, no manual mapping). Every node is a real declaration (a function, a class, or a
 * method); every edge is either:
 *  - a "call": a call site the pinned source actually contains, resolved as precisely as static
 *    typing information in the source allows (a bare top-level call, or a member call resolved
 *    through the receiver's DECLARED type — a constructor-injected property, or an interface
 *    field — never by matching a method name anywhere in the codebase); or
 *  - an "implements": an interface method resolved to the ONE concrete class that implements it
 *    in the pinned source. When more than one implementation exists, this resolution is
 *    genuinely ambiguous (it depends on runtime configuration / dependency injection a static
 *    reader cannot decide), so no edge is added — the chain simply cannot be proven past that
 *    point, and callers of discoverFlow surface that as the boundary of the analysis rather than
 *    guessing which implementation runs.
 * Entry points are exported functions that receive a `Request` and return a `Response`, or that
 * return a named handler type of that shape (a handler factory such as `createHttpHandler(deps):
 * HttpHandler`, whose returned closure is what actually receives the request).
 *
 * WHERE a chain starts is decided by the learner's stated intent (FlowIntent), never by the goal
 * text alone:
 *  - "trace_request": follow a request entering the system — the chain must start at a real HTTP
 *    entry point and every candidate must be reachable from one; without one, discovery fails.
 *  - "other": a free technical goal — no HTTP entry is forced. The chain starts at the OUTERMOST
 *    goal-related callable (function or method): one that no other goal-related symbol provably
 *    reaches. HTTP only appears if a goal-related symbol lives there.
 * Everything after the start is the same engine: verified edges, whole-chain relevance, honest stops.
 * This is not limited to any particular chain shape or length. Nothing that cannot be proven this
 * way is returned: when no entry point, no relevant symbol, or no connecting chain exists,
 * discovery fails loudly instead of guessing.
 */

export type CodeSymbol = { path: string; symbol: string; container: string | null; startLine: number; endLine: number };
export type EdgeKind = "call" | "implements";
export type FlowEdge = { from: CodeSymbol; to: CodeSymbol; line: number; snippet: string; kind: EdgeKind; argsText: string };
export type FlowIntent = Extract<LearningGoalKind, "trace_request" | "other">;
/**
 * Where the provable chain leaves the repository: the chain's last node calls through a dependency whose
 * declared type belongs to an external package (imported, or extended by a class of the repository), and
 * the called member is not declared anywhere in the pinned source. The call site itself is real and
 * verifiable; what is on the other side of it is not in the snapshot, so it is a boundary, never a node.
 */
export type ExternalCall = {
  from: CodeSymbol;
  line: number;
  snippet: string;
  argsText: string;
  /** The calling declaration's own signature, as written (parameters and their defaults feed the call). */
  signature: string;
  /** The receiver as written at the call site, e.g. ["this", "prisma", "transaction"]. */
  receiver: string[];
  /** The type the receiver resolves to from declared types (the last resolvable prefix of `receiver`). */
  dependency: string;
  /** The external class: the dependency itself, or the imported class it extends. */
  base: string;
  /** The package specifier it is imported from. */
  module: string;
  /** What is asked of the external type, in order: the receiver's remaining segments, then the method. */
  members: string[];
};
export type FlowPath = { goal: string; intent: FlowIntent; keywords: string[]; entry: CodeSymbol; target: CodeSymbol; chain: CodeSymbol[]; edges: FlowEdge[]; external: ExternalCall | null };

const toSymbol = (d: Declaration): CodeSymbol => ({ path: d.path, symbol: d.symbol, container: d.container, startLine: d.startLine, endLine: d.endLine });
const nodeKey = (d: { path: string; symbol: string; container: string | null }): string => `${d.path}#${d.container ?? ""}#${d.symbol}`;

function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** camelCase / PascalCase / snake_case / kebab-case / free text -> lowercase word parts. Used for
 *  both identifier names and source lines, so an identifier embedded in code ("createDecision")
 *  is recognized the same way as the declaration named `createDecision`. */
export function wordsOf(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return fold(spaced)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

const STOPWORDS = new Set([
  // Portuguese function words a goal sentence is built from.
  "quero", "entender", "como", "funciona", "funcionam", "projeto", "neste", "nesse", "desse", "deste",
  "de", "da", "do", "das", "dos", "e", "o", "a", "os", "as", "um", "uma", "uns", "umas",
  "para", "com", "sem", "que", "este", "esta", "esse", "essa", "isso", "no", "na", "nos", "nas",
  // English equivalents, for goals typed in English.
  "the", "a", "an", "of", "in", "on", "for", "to", "how", "does", "this", "project", "understand", "works",
]);

/**
 * A small, generic Portuguese -> English bridge for software-engineering concepts whose PT and
 * EN spellings do not share enough letters for the cognate matching below to bridge them (e.g.
 * "autenticação" vs "authorized" — real, related, but textually distant). It only covers specific,
 * discriminating domain vocabulary; generic protocol nouns ("requisição", "resposta") are
 * deliberately left untranslated because they match almost every HTTP handler and would drown
 * the signal. Extend this list for new domains; never branch generation logic on these words.
 */
const GOAL_GLOSSARY: Record<string, string[]> = {
  autenticacao: ["auth", "authenticate", "authentication", "authoriz", "authorized", "authorization", "unauthorized"],
  autorizacao: ["auth", "authoriz", "authorized", "authorization", "unauthorized"],
  autorizado: ["authorized"],
  autorizar: ["authorize", "authorized"],
  permissao: ["permission", "authorized"],
  chave: ["key", "apikey"],
  senha: ["password"],
  usuario: ["user"],
  token: ["token"],
  sessao: ["session"],
  seguranca: ["security"],
  // "save/create/complete/store/write" are generic CRUD write verbs, not Prisma-specific: they
  // only ever enter the search when the goal itself uses a persistence word, and they are what
  // separates writing a record ("completar", "criar", "salvar" a decision) from merely reading
  // one back ("consultar", "buscar" an audit) — real code overwhelmingly names write operations
  // with exactly these verbs, in any persistence layer.
  persistencia: ["persist", "persistence", "repository", "save", "create", "complete", "store", "write"],
  persistida: ["persist", "persistence", "repository", "save", "create", "complete", "store", "write"],
  persistido: ["persist", "persistence", "repository", "save", "create", "complete", "store", "write"],
  persistir: ["persist", "persistence", "repository", "save", "create", "complete", "store", "write"],
  banco: ["database"],
  fila: ["queue"],
  evento: ["event"],
  validacao: ["valid", "validate", "validation"],
  classificacao: ["classify", "classifier"],
  politica: ["policy"],
  teste: ["test"],
  limite: ["limit", "rate"],
  metrica: ["metric"],
  registro: ["log", "logger"],
  criar: ["create"],
  criada: ["create"],
  criado: ["create"],
  criacao: ["create"],
  pagamento: ["payment"],
  provedor: ["provider"],
  tentativa: ["retry", "attempt"],
  disjuntor: ["circuit", "breaker"],
  idempotente: ["idempotent", "idempotency"],
};

function singularize(word: string): string {
  if (word.endsWith("coes") || word.endsWith("soes")) return `${word.slice(0, -3)}ao`;
  return word.replace(/s$/, "");
}

/** One entry per meaningful word of the goal: the word, its singular and its glossary translations —
 *  everything that counts as "that concept" when reading the code. */
function goalConcepts(goal: string): Set<string>[] {
  return wordsOf(goal)
    .filter((word) => !STOPWORDS.has(word))
    .map((word) => {
      const singular = singularize(word);
      return new Set([word, singular, ...(GOAL_GLOSSARY[word] ?? GOAL_GLOSSARY[singular] ?? [])]);
    });
}

/** Free-text goal -> a set of normalized keywords, expanded through the small glossary above. */
export function tokenizeGoal(goal: string): Set<string> {
  return new Set(goalConcepts(goal).flatMap((concept) => [...concept]));
}

/**
 * Two words are the "same" concept if they are identical, or share a long-enough common PREFIX —
 * the generic way most Portuguese/English technical cognates relate ("decisão"/"decision" share
 * "decis", "triagem"/"triage" share "triage", "persistida"/"persistence" share "persist"). Short
 * words require an exact match so this does not turn into free-form fuzzy search. This single
 * rule does far more cross-language work than hand-listing every inflection in the glossary
 * above, and it is not tied to any domain.
 */
function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function related(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  return commonPrefixLength(a, b) >= 5;
}

const anyRelated = (words: Iterable<string>, goalToken: string): boolean => {
  for (const word of words) if (related(word, goalToken)) return true;
  return false;
};

function declarationText(index: RepositoryIndex, d: Declaration): string {
  return (index.files.get(d.path) ?? "").split("\n").slice(d.startLine - 1, d.endLine).join("\n");
}

/**
 * Relevance is judged by IDENTITY — a declaration's own name and its enclosing class/interface's
 * name (e.g. "PrismaTriageRunRepository" is itself strong evidence for a persistence goal) —
 * never by scanning a declaration's whole body for keywords. A body-scan sounds more thorough,
 * but a single large multi-purpose function (a router, an orchestrator) mentions almost every
 * concept the application has and would out-score the small, focused symbol actually being asked
 * about. Precise, call-site-scoped text (see edgeRelevance below) is used instead when a body's
 * content genuinely matters — deciding which of several real calls to follow.
 */
function scoreDeclaration(d: { symbol: string; container: string | null }, goalTokens: Set<string>): number {
  const nameTokens = new Set([...wordsOf(d.symbol), ...(d.container ? wordsOf(d.container) : [])]);
  let score = 0;
  for (const token of goalTokens) if (anyRelated(nameTokens, token)) score += 3;
  return score;
}

/** A named function type taking a `Request` and returning a `Response` (or a Promise of one), e.g.
 *  `export type HttpHandler = (request: Request) => Promise<Response>;`. */
const HANDLER_TYPE = /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*[A-Za-z_$][\w$]*\s*:\s*Request\b[^)]*\)\s*=>\s*(?:Promise<\s*)?Response\b/;

function handlerTypeNames(index: RepositoryIndex): Set<string> {
  const names = new Set<string>();
  for (const d of index.declarations) {
    if (d.container !== null) continue;
    const match = HANDLER_TYPE.exec(declarationText(index, d).replace(/\s+/g, " "));
    if (match?.[1] === d.symbol) names.add(d.symbol);
  }
  return names;
}

/** A declaration's signature: its lines up to (and including) the one that opens its body. */
export function signatureOf(index: RepositoryIndex, d: Declaration): string {
  const lines = (index.files.get(d.path) ?? "").split("\n").slice(d.startLine - 1, d.endLine);
  const openIndex = lines.findIndex((line) => /\{\s*$/.test(line));
  return lines.slice(0, openIndex === -1 ? 1 : openIndex + 1).join(" ");
}

export type EntryShape = "handler" | "handler-factory";

function entryShapeOf(index: RepositoryIndex, d: Declaration, handlerTypes: Set<string>): EntryShape | null {
  if (d.container !== null) return null;
  const signature = signatureOf(index, d);
  if (!/^export\s+(?:default\s+)?(?:async\s+)?function\b/.test(signature)) return null;
  if (/:\s*Request\b/.test(signature) && /:\s*(?:Promise<)?Response\b/.test(signature)) return "handler";
  for (const name of handlerTypes) if (new RegExp(`\\)\\s*:\\s*${escapeRegExp(name)}\\s*\\{$`).test(signature.trim())) return "handler-factory";
  return null;
}

/**
 * A generic HTTP entry point: an exported top-level function taking a `Request` and returning a
 * `Response` (or `Promise<Response>`), or one returning a named handler type of that shape (a
 * handler factory: the closure it returns is what receives the request, and the factory's body is
 * where that closure's calls live). Internal helpers with the same shape (e.g. a private router
 * called only from the entry point) are excluded by requiring `export`.
 */
export function findEntryPoints(index: RepositoryIndex): CodeSymbol[] {
  const handlerTypes = handlerTypeNames(index);
  return index.declarations.filter((d) => entryShapeOf(index, d, handlerTypes) !== null).map(toSymbol);
}

/** How the chain's first node receives requests, so a narrative can describe it truthfully. */
export function entryShape(index: RepositoryIndex, entry: CodeSymbol): EntryShape {
  const d = index.declarations.find((decl) => decl.path === entry.path && decl.symbol === entry.symbol && decl.container === entry.container);
  return (d && entryShapeOf(index, d, handlerTypeNames(index))) || "handler";
}

// ---------------------------------------------------------------------------------------------
// Declared-type resolution: reading TypeScript's own type annotations (constructor-injected
// properties, interface fields, function parameters) to resolve `receiver.method(` call sites
// precisely, instead of matching a method name anywhere in the codebase.
// ---------------------------------------------------------------------------------------------

export function isInterfaceDeclaration(index: RepositoryIndex, path: string, symbol: string): boolean {
  const decl = index.declarations.find((d) => d.path === path && d.symbol === symbol && d.container === null);
  if (!decl) return false;
  const line = (index.files.get(path) ?? "").split("\n")[decl.startLine - 1] ?? "";
  return /^(?:export\s+)?(?:default\s+)?interface\b/.test(line);
}

function isClassDeclaration(index: RepositoryIndex, decl: Declaration): boolean {
  const line = (index.files.get(decl.path) ?? "").split("\n")[decl.startLine - 1] ?? "";
  return /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b/.test(line);
}

/** Text between the "(" at `openIndex` and its matching ")", tracking nesting depth. */
function parenSpan(text: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return text.slice(openIndex + 1);
}

/** `identifier: TypeIdentifier` pairs at declaration positions (after `(`, `,`, `{`, `;`, or the
 *  start of the text) — covers constructor parameter properties, interface/type fields, and plain
 *  function parameters, all of which share this same TypeScript syntax shape. A type written
 *  `Pick<X, "m">` (likewise Omit/Readonly/Required/Partial/NonNullable) resolves to X: those
 *  utility types only narrow which of X's members are visible, so a call through them still
 *  lands on X's own declaration of that member. */
function typedFieldsIn(text: string): Map<string, string> {
  const map = new Map<string, string>();
  // `\s*` after the alternation, not inside it: the first parameter may start on its own line.
  const pattern = /(?:^|[(,{;])\s*(?:private\s+|public\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\??\s*:\s*(?:(?:Pick|Omit|Readonly|Required|Partial|NonNullable)<\s*)?([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const [, name, type] = match;
    if (name && type && !map.has(name)) map.set(name, type);
  }
  return map;
}

/** A declaration's own parameter list (function/method signature, or a class's constructor —
 *  found as the first "(" in the class body, matching this codebase's constructor-first style). */
export function parameterTypesOf(index: RepositoryIndex, d: Declaration): Map<string, string> {
  const text = declarationText(index, d);
  const openIndex = text.indexOf("(");
  if (openIndex === -1) return new Map();
  return typedFieldsIn(parenSpan(text, openIndex));
}

/** `type Name = { ... }`: as declarative as an interface, so its fields can be read whole. */
function isObjectTypeAlias(index: RepositoryIndex, d: Declaration): boolean {
  const line = (index.files.get(d.path) ?? "").split("\n")[d.startLine - 1] ?? "";
  return d.container === null && /^(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*=\s*\{/.test(line);
}

/** A type's own property types: for an interface or an object type alias, every declared field (a
 *  plain, declarative body with no executable code, so scanning it whole is safe); for a class,
 *  only its constructor-injected properties (scanning a class's whole body risks matching
 *  object-literal keys inside method bodies, so we deliberately do not). */
export function propertyTypesOf(index: RepositoryIndex, d: Declaration): Map<string, string> {
  if (isInterfaceDeclaration(index, d.path, d.symbol) || isObjectTypeAlias(index, d)) return typedFieldsIn(declarationText(index, d));
  return parameterTypesOf(index, d);
}

function findTopLevel(index: RepositoryIndex, symbol: string): Declaration | undefined {
  return index.declarations.find((d) => d.container === null && d.symbol === symbol);
}

/**
 * Resolves a dotted receiver chain (e.g. `["this", "triageRunRepository"]` from
 * `this.triageRunRepository.complete(`, or `["dependencies", "triageService"]` from
 * `dependencies.triageService.execute(`) to the DECLARED type it ends on, by reading real type
 * annotations only. `this` resolves to the caller's own enclosing class; any other first segment
 * is looked up among the caller's own parameters. Each further segment is looked up as a property
 * of the previously resolved type. Returns null the moment a segment cannot be resolved from a
 * real declared type — never a guess.
 */
export function resolveReceiverType(index: RepositoryIndex, caller: Declaration, chain: string[]): string | null {
  if (!chain.length) return null;
  let currentType: string;
  let rest: string[];
  if (chain[0] === "this") {
    if (!caller.container) return null;
    currentType = caller.container;
    rest = chain.slice(1);
  } else {
    const type = parameterTypesOf(index, caller).get(chain[0]!);
    if (!type) return null;
    currentType = type;
    rest = chain.slice(1);
  }
  for (const prop of rest) {
    const typeDecl = findTopLevel(index, currentType);
    if (!typeDecl) return null;
    const next = propertyTypesOf(index, typeDecl).get(prop);
    if (!next) return null;
    currentType = next;
  }
  return currentType;
}

/** Every class in the pinned source that textually declares `implements InterfaceName` and has
 *  its own member of the same method name — the real, provable set of candidate implementations.
 *  Exactly one means the call can be followed with certainty; any other count means it cannot. */
function implementationsOf(index: RepositoryIndex, declarations: Declaration[], interfaceName: string, methodName: string): Declaration[] {
  const results: Declaration[] = [];
  for (const classDecl of declarations) {
    if (classDecl.container !== null || !isClassDeclaration(index, classDecl)) continue;
    const line = (index.files.get(classDecl.path) ?? "").split("\n")[classDecl.startLine - 1] ?? "";
    const implementsMatch = /\bimplements\s+([^{]+)\{?/.exec(line);
    if (!implementsMatch) continue;
    const names = implementsMatch[1]!.split(",").map((part) => part.trim().split(/[\s<]/)[0]);
    if (!names.includes(interfaceName)) continue;
    const member = declarations.find((d) => d.path === classDecl.path && d.container === classDecl.symbol && d.symbol === methodName);
    if (member) results.push(member);
  }
  return results;
}

const DOTTED_CALL = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;

/**
 * Every declaration (function, class, or method) is both a possible graph node and a possible
 * relevance target — persistence, for instance, mostly lives in class methods, not top-level
 * functions. Two kinds of edges are built:
 *  - a bare top-level call (`symbol(`, or `new Symbol(`) is unambiguous by construction;
 *  - a member call (`receiver.method(`, however many segments) is resolved through the
 *    receiver's DECLARED type (see resolveReceiverType) to find exactly which declaration it
 *    calls — never by matching the method name against every declaration in the codebase.
 * When a resolved call lands on an INTERFACE method, a further "implements" edge is added to the
 * concrete implementation, but only when exactly one exists in the pinned source; otherwise no
 * edge is added; the chain cannot be proven past that point.
 */
function buildCallGraph(index: RepositoryIndex, declarations: Declaration[]): Map<string, FlowEdge[]> {
  const edgesFrom = new Map<string, FlowEdge[]>();
  const push = (edge: FlowEdge): void => {
    const key = nodeKey(edge.from);
    const list = edgesFrom.get(key) ?? [];
    if (!list.some((existing) => nodeKey(existing.to) === nodeKey(edge.to))) list.push(edge);
    edgesFrom.set(key, list);
  };

  for (const caller of declarations) {
    const bodyLines = (index.files.get(caller.path) ?? "").split("\n").slice(caller.startLine - 1, caller.endLine);
    const body = bodyLines.join("\n");

    // Bare top-level calls / constructions.
    for (const callee of declarations) {
      if (callee.container !== null || callee === caller) continue;
      // Never a member call: `Response.json(` is not a call to a top-level `json`.
      const pattern = new RegExp(`(?<![.\\w$])${escapeRegExp(callee.symbol)}\\s*\\(`);
      const match = pattern.exec(body);
      if (!match) continue;
      const openIndex = match.index + match[0].length - 1;
      const lineIndex = body.slice(0, match.index).split("\n").length - 1;
      push({
        from: toSymbol(caller),
        to: toSymbol(callee),
        line: caller.startLine + lineIndex,
        snippet: (bodyLines[lineIndex] ?? "").trim(),
        kind: "call",
        argsText: parenSpan(body, openIndex),
      });
    }

    // Member calls, resolved through declared types.
    for (const match of body.matchAll(DOTTED_CALL)) {
      const parts = match[1]!.split(".");
      const method = parts.at(-1)!;
      const receiverChain = parts.slice(0, -1);
      const type = resolveReceiverType(index, caller, receiverChain);
      if (!type) continue;
      let callee = declarations.find((d) => d.container === type && d.symbol === method);
      let edgeKind: EdgeKind = "call";
      if (!callee) {
        // The declared type's own declaration is not in the indexed source at all (a common,
        // honest gap: a pinned snapshot rarely includes every file the real repository has —
        // here, application/ports/triage-service.ts). We can still tell, from the concrete
        // classes we DO have, whether exactly one of them implements that named contract.
        const implementations = implementationsOf(index, declarations, type, method);
        if (implementations.length === 1) {
          callee = implementations[0];
          edgeKind = "implements";
        }
      }
      if (!callee || callee === caller) continue;
      // This call's OWN arguments only — the exact parenthesized span right after this match,
      // never a fixed window of following lines (which would just as easily belong to the next
      // property in the same object literal, or even the next function entirely).
      const openIndex = match.index! + match[0]!.length - 1;
      const argsText = parenSpan(body, openIndex);
      const lineIndex = body.slice(0, match.index).split("\n").length - 1;
      push({
        from: toSymbol(caller),
        to: toSymbol(callee),
        line: caller.startLine + lineIndex,
        snippet: (bodyLines[lineIndex] ?? "").trim(),
        kind: edgeKind,
        argsText,
      });

      if (edgeKind === "call" && isInterfaceDeclaration(index, callee.path, type)) {
        const implementations = implementationsOf(index, declarations, type, method);
        if (implementations.length === 1) {
          push({ from: toSymbol(callee), to: toSymbol(implementations[0]!), line: implementations[0]!.startLine, snippet: `class ${implementations[0]!.container} implements ${type}`, kind: "implements", argsText: "" });
        }
      }
    }
  }
  return edgesFrom;
}

/** BFS over verified call edges (regex-matched call sites in the pinned source), capped at a
 *  shallow depth so the result stays a minimal graph, not a whole-repository trace. */
function shortestPath(entries: CodeSymbol[], targetKey: string, edgesFrom: Map<string, FlowEdge[]>, maxDepth: number): FlowEdge[] | null {
  const visited = new Set(entries.map(nodeKey));
  const queue: { key: string; path: FlowEdge[] }[] = entries.map((entry) => ({ key: nodeKey(entry), path: [] }));
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    if (current.key === targetKey && current.path.length > 0) return current.path;
    if (current.path.length >= maxDepth) continue;
    for (const edge of edgesFrom.get(current.key) ?? []) {
      const key = nodeKey(edge.to);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ key, path: [...current.path, edge] });
    }
  }
  return null;
}

/** Every node reachable from `startKey` through verified edges, within the same hop cap. */
function reachableFrom(startKey: string, edgesFrom: Map<string, FlowEdge[]>): Set<string> {
  const seen = new Set<string>();
  let frontier = [startKey];
  for (let depth = 0; depth < MAX_HOPS && frontier.length; depth++) {
    frontier = frontier.flatMap((key) => (edgesFrom.get(key) ?? []).map((edge) => nodeKey(edge.to))).filter((key) => !seen.has(key) && seen.add(key));
  }
  return seen;
}

const FUNCTION_LIKE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;

/** Behaviour a learner can start reading at: a function, an arrow-function const, or a method of a
 *  class. Not a class or interface (whose "body" is every method it holds), not an interface member
 *  (no body), and not a value (`const repo = new PostgresRepo(sql)` is wiring, not behaviour). */
function hasCallableBody(index: RepositoryIndex, d: Declaration): boolean {
  if (d.container !== null) {
    const container = index.declarations.find((c) => c.container === null && c.path === d.path && c.symbol === d.container);
    return container !== undefined && isClassDeclaration(index, container);
  }
  return FUNCTION_LIKE.test((index.files.get(d.path) ?? "").split("\n")[d.startLine - 1] ?? "");
}

/** How many of the goal's concepts a declaration's own identity (name + container) carries. */
function conceptsCarried(d: Declaration, concepts: Set<string>[]): number {
  const nameTokens = new Set([...wordsOf(d.symbol), ...(d.container ? wordsOf(d.container) : [])]);
  return concepts.filter((concept) => [...concept].some((token) => anyRelated(nameTokens, token))).length;
}

/**
 * Start points for a free technical goal: callables (see hasCallableBody) that are about the goal
 * and that no OTHER such callable provably reaches (mutual reachability, i.e. a cycle, dominates
 * neither side). "About the goal" means carrying at least two of its concepts whenever the code has
 * two — one concept alone is often just a generic verb the glossary expanded (`create`, `write`),
 * which would make an HTTP factory named `createHttpHandler` look like it is "about persistence".
 */
function outermostRelevant(index: RepositoryIndex, relevant: Declaration[], concepts: Set<string>[], edgesFrom: Map<string, FlowEdge[]>): CodeSymbol[] {
  const carried = new Map(relevant.map((d) => [d, conceptsCarried(d, concepts)] as const));
  const required = Math.min(2, Math.max(0, ...carried.values()));
  const callable = relevant.filter((d) => hasCallableBody(index, d) && (carried.get(d) ?? 0) >= required);
  const reach = new Map(callable.map((d) => [nodeKey(d), reachableFrom(nodeKey(d), edgesFrom)]));
  return callable
    .filter((d) => !callable.some((other) => other !== d && reach.get(nodeKey(other))!.has(nodeKey(d)) && !reach.get(nodeKey(d))!.has(nodeKey(other))))
    .map(toSymbol);
}

/** Minimal graph: a path longer than this is refused rather than returned, so a stage generator
 *  downstream never has to teach an unbounded number of hops in one journey. */
const MAX_HOPS = 6;

/** A few lines of real source starting at an edge's call site — not the callee's whole body, just
 *  what is actually passed at THIS call (e.g. `{ runId, decisionId, decision, completedAt }`).
 *  This is what lets the walk below tell "persist the decision" apart from "persist the run's
 *  start" or "record a failure" when a component makes several real, otherwise similarly-named
 *  calls: the deciding evidence is in the arguments, not in either method's name. */
function edgeContextWords(edge: FlowEdge): Set<string> {
  return new Set(wordsOf(edge.argsText));
}

/**
 * How well one OUTGOING edge from the current node fits the goal, used only to choose between
 * several real, otherwise-plausible next steps (see extendPath). The enclosing container's name
 * is only counted when it differs from the node we are leaving — two methods of the very same
 * class both look equally "relevant" by class name alone, so that signal cannot tell them apart
 * and is dropped in favour of what actually distinguishes them: each call's own arguments.
 */
function edgeRelevance(index: RepositoryIndex, edge: FlowEdge, goalTokens: Set<string>, fromContainer: string | null): number {
  const nameTokens = new Set(wordsOf(edge.to.symbol));
  if (edge.to.container && edge.to.container !== fromContainer) for (const word of wordsOf(edge.to.container)) nameTokens.add(word);
  const args = edgeContextWords(edge);
  let score = 0;
  for (const token of goalTokens) {
    if (anyRelated(nameTokens, token)) score += 3;
    else if (anyRelated(args, token)) score += 2;
  }
  return score;
}

/**
 * Extends a chain forward from an already-relevant anchor, following only what static analysis
 * can prove: an `implements` edge is always taken (it exists at all only when exactly one
 * implementation exists, so there is nothing to choose between); a `call` edge is taken only when
 * exactly one of the current node's outgoing calls is relevant to the goal. Two or more
 * plausible next steps, or none, ends the walk right there — a real fork or a real leaf, not a
 * refusal to look.
 */
function extendPath(index: RepositoryIndex, edgesFrom: Map<string, FlowEdge[]>, start: CodeSymbol, goalTokens: Set<string>, alreadyVisited: Iterable<string>, budget: number): FlowEdge[] {
  const path: FlowEdge[] = [];
  const visited = new Set(alreadyVisited);
  let current = start;
  while (path.length < budget) {
    const options = (edgesFrom.get(nodeKey(current)) ?? []).filter((edge) => !visited.has(nodeKey(edge.to)));
    if (!options.length) break;
    const implementsEdge = options.find((edge) => edge.kind === "implements");
    let next: FlowEdge | undefined = implementsEdge;
    if (!next) {
      const ranked = options.map((edge) => ({ edge, score: edgeRelevance(index, edge, goalTokens, current.container) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
      if (ranked.length === 1 || (ranked.length > 1 && ranked[0]!.score > ranked[1]!.score)) next = ranked[0]!.edge;
    }
    if (!next) break;
    path.push(next);
    visited.add(nodeKey(next.to));
    current = next.to;
  }
  return path;
}

/** Local names a file imports from a non-relative module (a package, not a file of the repository). */
function externalImports(index: RepositoryIndex, path: string): Map<string, string> {
  const imports = new Map<string, string>();
  const text = index.files.get(path) ?? "";
  for (const match of text.matchAll(/import\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
    const [, defaultName, named, module] = match;
    if (!module || module.startsWith(".") || module.startsWith("/")) continue;
    if (defaultName) imports.set(defaultName, module);
    for (const entry of (named ?? "").split(",")) {
      const local = /(?:\bas\s+)?([A-Za-z_$][\w$]*)\s*$/.exec(entry.trim().replace(/^type\s+/, ""))?.[1];
      if (local) imports.set(local, module);
    }
  }
  return imports;
}

/** A class's header up to the brace that opens its body (`class A extends B implements C`). */
function classHeader(index: RepositoryIndex, d: Declaration): string {
  const lines = (index.files.get(d.path) ?? "").split("\n").slice(d.startLine - 1, d.endLine);
  const open = lines.findIndex((line) => line.includes("{"));
  return lines.slice(0, open === -1 ? 1 : open + 1).join(" ");
}

/** True when the class text itself declares a member called `name` (a method, a property or a constructor property). */
function declaresMember(index: RepositoryIndex, d: Declaration, name: string): boolean {
  if (index.declarations.some((m) => m.path === d.path && m.container === d.symbol && m.symbol === name)) return true;
  if (propertyTypesOf(index, d).has(name)) return true;
  return new RegExp(`^\\s+(?:(?:public|private|protected|readonly|static|declare)\\s+)*${escapeRegExp(name)}\\b`, "m").test(declarationText(index, d));
}

/**
 * The external type a dependency stands for, with the package it comes from — only from what the source
 * itself states: the type is imported from a package, or it is a class of the repository that `extends` a
 * class imported from a package. Returns null for anything else (never a guess from a name).
 */
function externalTypeOf(index: RepositoryIndex, callerPath: string, type: string, member: string): { base: string; module: string } | null {
  const own = findTopLevel(index, type);
  if (!own) {
    const module = externalImports(index, callerPath).get(type);
    return module ? { base: type, module } : null;
  }
  if (!isClassDeclaration(index, own) || declaresMember(index, own, member)) return null;
  const base = /\bextends\s+([A-Za-z_$][\w$]*)/.exec(classHeader(index, own))?.[1];
  const module = base ? externalImports(index, own.path).get(base) : undefined;
  return base && module ? { base, module } : null;
}

/**
 * The one call from `node` that leaves the repository and is about the goal — when the chain's last node
 * has nothing left to follow inside the repository. Each dotted call is resolved through declared types
 * as far as the source allows (the longest prefix that resolves); if what remains is not declared by the
 * repository but belongs to an external type (see externalTypeOf), it is a candidate. Judged by the same
 * relevance as any other next step (edgeRelevance's evidence: the called names, then the call's own
 * arguments); zero or several equally relevant candidates mean no boundary is claimed.
 */
function externalBoundary(index: RepositoryIndex, edgesFrom: Map<string, FlowEdge[]>, node: CodeSymbol, goalTokens: Set<string>): ExternalCall | null {
  if ((edgesFrom.get(nodeKey(node)) ?? []).length) return null;
  const caller = declOf(index, node);
  if (!caller || !hasCallableBody(index, caller)) return null;
  const bodyLines = declarationText(index, caller).split("\n");
  const body = bodyLines.join("\n");
  const found: { call: ExternalCall; score: number }[] = [];
  for (const match of body.matchAll(DOTTED_CALL)) {
    const parts = match[1]!.split(".");
    const receiver = parts.slice(0, -1);
    for (let length = receiver.length; length >= (receiver[0] === "this" ? 2 : 1); length--) {
      const dependency = resolveReceiverType(index, caller, receiver.slice(0, length));
      if (!dependency) continue;
      const members = parts.slice(length);
      const external = externalTypeOf(index, caller.path, dependency, members[0]!);
      if (external) {
        const openIndex = match.index! + match[0]!.length - 1;
        const argsText = parenSpan(body, openIndex);
        const lineIndex = body.slice(0, match.index).split("\n").length - 1;
        const names = new Set(members.flatMap(wordsOf));
        const args = new Set(wordsOf(argsText));
        let score = 0;
        for (const token of goalTokens) score += anyRelated(names, token) ? 3 : anyRelated(args, token) ? 2 : 0;
        found.push({ call: { from: node, line: caller.startLine + lineIndex, snippet: (bodyLines[lineIndex] ?? "").trim(), argsText, signature: signatureOf(index, caller).replace(/\s+/g, " ").replace(/\s*\{$/, "").trim(), receiver, dependency, base: external.base, module: external.module, members }, score });
      }
      break;
    }
  }
  const ranked = found.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  return ranked.length === 1 || (ranked.length > 1 && ranked[0]!.score > ranked[1]!.score) ? ranked[0]!.call : null;
}

function declOf(index: RepositoryIndex, s: CodeSymbol): Declaration | undefined {
  return index.declarations.find((d) => d.path === s.path && d.symbol === s.symbol && d.container === s.container);
}

export function discoverFlow(goal: string, index: RepositoryIndex, intent: FlowIntent): FlowPath {
  const entries = intent === "trace_request" ? findEntryPoints(index) : [];
  if (intent === "trace_request" && !entries.length) {
    throw new Error("Nenhum ponto de entrada HTTP encontrado no SHA fixado (uma função exportada que recebe Request e devolve Response).");
  }
  const goalTokens = tokenizeGoal(goal);
  if (!goalTokens.size) throw new Error(`Não foi possível extrair palavras-chave do objetivo "${goal}".`);

  const scoredAll = index.declarations.map((d) => ({ d, score: scoreDeclaration(d, goalTokens) })).filter((entry) => entry.score > 0);
  if (!scoredAll.length) throw new Error(`Nenhum símbolo do repositório no SHA fixado corresponde ao objetivo "${goal}".`);

  const edgesFrom = buildCallGraph(index, index.declarations);
  const roots = intent === "trace_request" ? entries : outermostRelevant(index, scoredAll.map((entry) => entry.d), goalConcepts(goal), edgesFrom);
  const rootKeys = new Set(roots.map(nodeKey));

  // A symbol's own name is often a weak, ambiguous signal on its own (many real methods on the
  // same relevant class share its class name; a generic verb like "execute" says nothing by
  // itself). What is decisive is where following it actually LEADS: for every candidate reachable
  // from an entry point, extend the chain as far as real, unambiguous calls go (extendPath), then
  // judge the candidate by the total relevance of the whole resulting chain — not by its own
  // first hop's score alone. This is what lets a write path ending in a real storage operation
  // outrank a same-named read path that happens to score just as well one hop in.
  const candidates = scoredAll
    .map((entry) => {
      // A traced request must REACH the anchor from an HTTP entry; a free goal may start at the anchor itself.
      const initial = intent === "other" && rootKeys.has(nodeKey(entry.d)) ? [] : shortestPath(roots, nodeKey(entry.d), edgesFrom, MAX_HOPS);
      if (!initial) return null;
      const anchor = toSymbol(entry.d);
      const visited = [initial.length ? nodeKey(initial[0]!.from) : nodeKey(anchor), ...initial.map((edge) => nodeKey(edge.to))];
      const extension = extendPath(index, edgesFrom, anchor, goalTokens, visited, MAX_HOPS - initial.length);
      const edges = [...initial, ...extension];
      if (!edges.length) return null;
      const chain = [edges[0]!.from, ...edges.map((edge) => edge.to)];
      // Both what each node IS (its own and its container's name) and what each call actually
      // PASSES matter: two sibling methods on the same relevant class (e.g. one that persists a
      // decision, one that records a failure) look identical by name/container alone — only the
      // real arguments at each call site tell them apart.
      const total =
        chain.reduce((sum, node) => sum + scoreDeclaration(node, goalTokens), 0) +
        edges.reduce((sum, edge) => sum + edgeRelevance(index, edge, goalTokens, edge.from.container), 0);
      // Density, not raw total: a chain one hop longer gets one more chance to match something
      // and would otherwise always look "more relevant" purely for being longer, independent of
      // whether that extra hop is actually about the goal.
      return { edges, chain, density: total / chain.length, hops: edges.length };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.density - a.density || b.hops - a.hops);

  if (!candidates.length) {
    throw new Error(
      `O objetivo "${goal}" corresponde a ${scoredAll.map((entry) => (entry.d.container ? `${entry.d.container}.${entry.d.symbol}` : entry.d.symbol)).join(", ")} no SHA fixado, mas ${intent === "trace_request" ? "nenhum ponto de entrada HTTP alcança esse símbolo" : "nenhuma chamada comprovada no código o conecta a outro símbolo"} por chamadas comprovadas no código.`,
    );
  }

  const best = candidates[0]!;
  const external = externalBoundary(index, edgesFrom, best.chain.at(-1)!, goalTokens);
  return { goal, intent, keywords: [...goalTokens], entry: best.edges[0]!.from, target: best.chain.at(-1)!, chain: best.chain, edges: best.edges, external };
}

/** For a chain's terminal node, when it sits on an interface: the concrete classes in the pinned
 *  source that implement that method. Anything but exactly one means the analysis cannot prove
 *  which one runs (it depends on runtime wiring) — the generator surfaces this explicitly, with
 *  these names, instead of claiming the chain reaches a concrete operation. */
export function interfaceImplementations(index: RepositoryIndex, node: CodeSymbol): string[] | null {
  if (!node.container || !isInterfaceDeclaration(index, node.path, node.container)) return null;
  return implementationsOf(index, index.declarations, node.container, node.symbol).flatMap((d) => (d.container ? [d.container] : []));
}
