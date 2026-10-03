import type { Declaration, RepositoryIndex } from "./code-map.ts";
import { entryShape, isInterfaceDeclaration, resolveReceiverType, type CodeSymbol, type ExternalCall, type FlowEdge } from "./flow-discovery.ts";

/**
 * Structure-faithful Replay code for a discovered chain.
 *
 * A chain is a list of real declarations joined by real call sites. The Replay reproduces the
 * STRUCTURE those call sites prove — never a different architecture that merely runs:
 *  - an interface stays an interface (never a class), and a class that implements it says so;
 *  - a dependency the real code receives (constructor parameter, function parameter, a property of
 *    a dependencies object) is received, never constructed inside the caller;
 *  - the call goes through that dependency (\`this.repository.save()\`, \`dependencies.service.run()\`),
 *    not around it; sibling methods share one class; async stays async;
 *  - declared types are copied verbatim from the real source (\`Pick<X, "m">\`, \`apiKey?: string\`).
 * What is simplified is DATA, never relations: every node returns a string, parameters that only
 * carry data are dropped, and a leaf's body is an explicit stand-in. A relation that cannot be
 * reproduced this way makes generation fail loudly instead of drifting to an invented shape.
 */

export type Typed = { name: string; type: string; optional: boolean };
export type NodeRole = "function" | "method" | "contract" | "external";
/** What an "external" node stands for: members of a type that lives in a package outside the snapshot. */
export type ExternalType = Pick<ExternalCall, "dependency" | "base" | "module" | "members" | "argsText" | "signature" | "snippet">;
export type ReplayNode = { sym: CodeSymbol; decl: Declaration | null; role: NodeRole; async: boolean; params: Typed[]; external?: ExternalType };
type CallSite = { line: number; snippet: string; args: string[] };
export type ReplayLink =
  | ({ kind: "call" } & CallSite)
  | ({ kind: "self" } & CallSite)
  | ({ kind: "member"; base: { via: "param" | "field"; name: string }; path: string[] } & CallSite)
  | { kind: "implements"; line: number; snippet: string };
export type ReplayModel = { nodes: ReplayNode[]; links: ReplayLink[]; handlerAlias: { name: string; requestParam: string } | null };

const unfaithful = (message: string): never => {
  throw new Error(`Estrutura real não reproduzível com fidelidade: ${message}`);
};

// ---------------------------------------------------------------------------------------------
// Reading the real source: signatures, constructor parameters, type members — verbatim.
// ---------------------------------------------------------------------------------------------

const declText = (index: RepositoryIndex, d: Declaration): string => (index.files.get(d.path) ?? "").split("\n").slice(d.startLine - 1, d.endLine).join("\n");
const findTopLevel = (index: RepositoryIndex, name: string): Declaration | undefined => index.declarations.find((d) => d.container === null && d.symbol === name);
const declOf = (index: RepositoryIndex, s: CodeSymbol): Declaration | undefined => index.declarations.find((d) => d.path === s.path && d.symbol === s.symbol && d.container === s.container);

/** Splits at depth-0 separators. Angle brackets count as nesting only when \`angles\` (type text). */
function splitTopLevel(text: string, separators: string, angles: boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "=" && text[i + 1] === ">") i++;
    else if ("([{".includes(c) || (angles && c === "<")) depth++;
    else if (")]}".includes(c) || (angles && c === ">")) depth--;
    else if (depth === 0 && separators.includes(c)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function matching(text: string, openIndex: number, open: string, close: string): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(openIndex + 1, i);
  }
  return text.slice(openIndex + 1);
}

/** \`name?: Type = default\` (with optional modifiers) -> its parts; anything else (a method, a destructured parameter) -> null. */
function parseTyped(entry: string): Typed | null {
  let cut = entry.length;
  let depth = 0;
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i]!;
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c) && !(c === ">" && entry[i - 1] === "=")) depth--;
    else if (c === "=" && depth === 0 && entry[i + 1] !== ">") {
      cut = i;
      break;
    }
  }
  const match = /^(?:(?:private|public|protected|readonly)\s+)*([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(entry.slice(0, cut).trim());
  return match ? { name: match[1]!, optional: match[2] === "?", type: match[3]!.trim() } : null;
}

function parametersOf(index: RepositoryIndex, d: Declaration): Typed[] {
  const text = declText(index, d);
  const open = text.indexOf("(");
  if (open === -1) return [];
  // A parameter we cannot read (destructuring) keeps its position under a placeholder name.
  return splitTopLevel(matching(text, open, "(", ")"), ",", true).map((entry, i) => parseTyped(entry) ?? { name: `_${i}`, type: "unknown", optional: true });
}

function constructorParametersOf(index: RepositoryIndex, classDecl: Declaration): Typed[] {
  const text = declText(index, classDecl);
  const at = text.indexOf("constructor(");
  if (at === -1) return [];
  return splitTopLevel(matching(text, at + "constructor".length, "(", ")"), ",", true).flatMap((entry) => parseTyped(entry) ?? []);
}

/** The declared members of an interface or object type alias (a purely declarative body). */
function membersOf(index: RepositoryIndex, typeDecl: Declaration): Typed[] {
  const text = declText(index, typeDecl).replace(/\/\/.*$/gm, "");
  const open = text.indexOf("{");
  if (open === -1) return [];
  return splitTopLevel(matching(text, open, "{", "}"), ";,\n", true).flatMap((entry) => parseTyped(entry) ?? []);
}

/** \`Pick<X, "m">\` (and the other narrowing utilities) -> X: the declaration a call through it lands on. */
const unwrapType = (type: string): string => /^(?:(?:Pick|Omit|Readonly|Required|Partial|NonNullable)<\s*)?([A-Za-z_$][\w$]*)/.exec(type.trim())?.[1] ?? type.trim();

function isAsync(index: RepositoryIndex, d: Declaration): boolean {
  const text = declText(index, d);
  const open = text.indexOf("(");
  const afterParams = open === -1 ? "" : text.slice(open + 1 + matching(text, open, "(", ")").length + 1);
  const head = afterParams.split(/[{;]/)[0] ?? "";
  return /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|override)\s+)*async\b/.test(text) || /^\s*:\s*Promise\b/.test(head);
}

const FUNCTION_LIKE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;

// ---------------------------------------------------------------------------------------------
// Chain -> model
// ---------------------------------------------------------------------------------------------

function nodeOf(index: RepositoryIndex, sym: CodeSymbol): ReplayNode {
  const decl = declOf(index, sym) ?? unfaithful(`${sym.symbol} não está no SHA fixado.`);
  if (sym.container === null) {
    if (!FUNCTION_LIKE.test(declText(index, decl).split("\n")[0] ?? "")) unfaithful(`${sym.symbol} não é uma função.`);
    return { sym, decl, role: "function", async: isAsync(index, decl), params: parametersOf(index, decl) };
  }
  const role: NodeRole = isInterfaceDeclaration(index, sym.path, sym.container) ? "contract" : "method";
  return { sym, decl, role, async: isAsync(index, decl), params: parametersOf(index, decl) };
}

function parseCallSite(edge: FlowEdge): { link: ReplayLink; receiver: string[] | null } {
  const method = edge.to.symbol;
  const site: CallSite = { line: edge.line, snippet: edge.snippet, args: splitTopLevel(edge.argsText, ",", false) };
  const dotted = new RegExp(`([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\.${method.replace(/[$]/g, "\\$")}\\s*\\(`).exec(edge.snippet);
  if (dotted) {
    const parts = dotted[1]!.split(".");
    if (parts[0] === "this") {
      const rest = parts.slice(1);
      if (rest.length === 0) return { link: { kind: "self", ...site }, receiver: null };
      return { link: { kind: "member", base: { via: "field", name: rest[0]! }, path: rest.slice(1), ...site }, receiver: parts };
    }
    return { link: { kind: "member", base: { via: "param", name: parts[0]! }, path: parts.slice(1), ...site }, receiver: parts };
  }
  if (!new RegExp(`(?<![.\\w$])${method.replace(/[$]/g, "\\$")}\\s*\\(`).test(edge.snippet)) unfaithful(`a chamada a ${method} em ${edge.from.path}:${edge.line} não pôde ser lida.`);
  return { link: { kind: "call", ...site }, receiver: null };
}

/** The file the Replay gives the learner for the external package: its types are not in the pinned source. */
export const EXTERNAL_FILE = "external.ts";

export function buildModel(index: RepositoryIndex, chain: CodeSymbol[], edges: FlowEdge[], external: ExternalCall | null = null): ReplayModel {
  const nodes: ReplayNode[] = [nodeOf(index, chain[0]!)];
  const links: ReplayLink[] = [];
  edges.forEach((edge, i) => {
    const caller = nodes.at(-1)!;
    if (edge.kind === "implements" && /^class\s/.test(edge.snippet.trim())) {
      links.push({ kind: "implements", line: edge.line, snippet: edge.snippet });
      nodes.push(nodeOf(index, chain[i + 1]!));
      return;
    }
    const { link, receiver } = parseCallSite(edge);
    if (edge.kind === "implements") {
      // The call goes through a contract whose own file is not in the indexed source: the type is known
      // (from the declaration the receiver resolves to) and exactly one class in the source implements it.
      const contract = receiver ? resolveReceiverType(index, caller.decl!, receiver) : null;
      if (!contract || link.kind !== "member") return unfaithful(`o contrato chamado em ${edge.from.path}:${edge.line} não pôde ser determinado.`);
      const virtual: CodeSymbol = { path: "", symbol: edge.to.symbol, container: contract, startLine: 0, endLine: 0 };
      const implementation = nodeOf(index, chain[i + 1]!);
      links.push(link, { kind: "implements", line: edge.line, snippet: `class ${implementation.sym.container} implements ${contract}` });
      nodes.push({ sym: virtual, decl: null, role: "contract", async: implementation.async, params: [] }, implementation);
      return;
    }
    links.push(link);
    nodes.push(nodeOf(index, chain[i + 1]!));
  });

  if (external) {
    // The last real call leaves the repository: one more link, to a stand-in for what the package provides.
    const { link } = parseCallSite({ from: external.from, to: { ...external.from, symbol: external.members.at(-1)! }, line: external.line, snippet: external.snippet, kind: "call", argsText: external.argsText });
    if (link.kind !== "member") return unfaithful(`a chamada externa em ${external.from.path}:${external.line} não passa por uma dependência.`);
    links.push(link);
    const symbol = external.members.join(".");
    nodes.push({ sym: { path: external.module, symbol, container: external.base, startLine: 0, endLine: 0 }, decl: null, role: "external", async: false, params: [], external });
  }

  const entry = nodes[0]!;
  let handlerAlias: ReplayModel["handlerAlias"] = null;
  if (entryShape(index, chain[0]!) === "handler-factory" && entry.decl) {
    const name = /\)\s*:\s*([A-Za-z_$][\w$]*)\s*\{/.exec(declText(index, entry.decl))?.[1];
    const alias = name ? findTopLevel(index, name) : undefined;
    const requestParam = alias ? /\(\s*([A-Za-z_$][\w$]*)\s*:\s*Request/.exec(declText(index, alias))?.[1] : undefined;
    if (!name || !requestParam) unfaithful(`o tipo do handler devolvido por ${entry.sym.symbol} não pôde ser lido.`);
    handlerAlias = { name: name!, requestParam: requestParam! };
  }
  return { nodes, links, handlerAlias };
}

// ---------------------------------------------------------------------------------------------
// What each node must receive to make the proven calls, and which declared types that implies.
// ---------------------------------------------------------------------------------------------

type Needs = {
  params: Set<string>[];
  /** class name -> constructor-injected properties its methods use, in constructor order. */
  fields: Map<string, Typed[]>;
  /** declared type name -> the members the chain reads through it, in declaration order. */
  typeMembers: Map<string, Typed[]>;
};

const SIMPLE_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function computeNeeds(index: RepositoryIndex, model: ReplayModel, last: number, keepAllParamsOfLast: boolean): Needs {
  const needs: Needs = { params: [], fields: new Map(), typeMembers: new Map() };
  const remember = (typeName: string, member: Typed): void => {
    const list = needs.typeMembers.get(typeName) ?? [];
    if (!list.some((m) => m.name === member.name)) list.push(member);
    needs.typeMembers.set(typeName, list);
  };
  /** Walks declared types along a property path, recording each member read; returns the final type text. */
  const walk = (typeText: string, path: string[], where: string): string => {
    let current = typeText;
    for (const prop of path) {
      const name = unwrapType(current);
      const decl = findTopLevel(index, name) ?? unfaithful(`o tipo ${name} (${where}) não está no SHA fixado.`);
      const member = membersOf(index, decl).find((m) => m.name === prop) ?? unfaithful(`${name} não declara ${prop} (${where}).`);
      remember(name, member);
      current = member.type;
    }
    return current;
  };

  for (let i = last; i >= 0; i--) {
    const node = model.nodes[i]!;
    const needed = new Set<string>();
    if (i === last) {
      if (keepAllParamsOfLast) for (const p of node.params) needed.add(p.name);
    } else {
      const link = model.links[i]!;
      const callee = model.nodes[i + 1]!;
      const where = `${node.sym.symbol}`;
      if (link.kind === "member") {
        // Through an external type only the part of the path the repository declares is read from its types;
        // the rest (`transaction` in `this.prisma.transaction.create`) belongs to the package.
        const declaredPath = callee.external ? link.path.slice(0, link.path.length - (callee.external.members.length - 1)) : link.path;
        let finalType: string;
        if (link.base.via === "param") {
          const param = node.params.find((p) => p.name === link.base.name) ?? unfaithful(`${link.base.name} não é parâmetro de ${where}.`);
          needed.add(param.name);
          finalType = walk(param.type, declaredPath, where);
        } else {
          const classDecl = findTopLevel(index, node.sym.container ?? "") ?? unfaithful(`a classe de ${where} não está no SHA fixado.`);
          const field = constructorParametersOf(index, classDecl).find((f) => f.name === link.base.name) ?? unfaithful(`${link.base.name} não é injetado pelo construtor de ${node.sym.container}.`);
          const list = needs.fields.get(node.sym.container ?? "") ?? [];
          if (!list.some((f) => f.name === field.name)) list.push(field);
          needs.fields.set(node.sym.container ?? "", list);
          finalType = walk(field.type, declaredPath, where);
        }
        const expected = callee.external ? callee.external.dependency : callee.sym.container;
        if (unwrapType(finalType) !== expected) unfaithful(`${where} chama ${callee.sym.container}.${callee.sym.symbol} por um tipo declarado como ${finalType}.`);
      }
      if (link.kind !== "implements") {
        // The callee's parameters that carry dependencies must be supplied by the caller's own parameters.
        for (const name of needs.params[i + 1] ?? []) {
          const position = callee.params.findIndex((p) => p.name === name);
          const expression = link.args[position];
          if (expression === undefined || !SIMPLE_PATH.test(expression)) return unfaithful(`${where} passa ${expression ?? "nada"} como ${name} de ${callee.sym.symbol}.`);
          const [root, ...path] = expression.split(".") as [string, ...string[]];
          if (i === 0 && root === model.handlerAlias?.requestParam) continue; // the handler's own request parameter
          const param = node.params.find((p) => p.name === root) ?? unfaithful(`${root} (passado por ${where}) não é parâmetro dele.`);
          needed.add(param.name);
          walk(param.type, path, where);
        }
      }
    }
    if (i === 0) for (const p of node.params) if (p.type === "Request") needed.add(p.name);
    needs.params[i] = needed;
  }
  for (const [name, members] of needs.typeMembers) {
    const decl = findTopLevel(index, name);
    const order = decl ? membersOf(index, decl).map((m) => m.name) : [];
    members.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  for (const [container, fields] of needs.fields) {
    const decl = findTopLevel(index, container);
    const order = decl ? constructorParametersOf(index, decl).map((f) => f.name) : [];
    fields.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  return needs;
}

// ---------------------------------------------------------------------------------------------
// Model + needs -> program text
// ---------------------------------------------------------------------------------------------

export type Block = { label: string; text: string };
export type Program = { code: string; blocks: Block[]; callStatement: string | null; needs: Needs; effectiveAsync: boolean[] };

const labelOf = (s: CodeSymbol): string => (s.container ? `${s.container}.${s.symbol}` : s.symbol);
export const standIn = (s: CodeSymbol): string => `corpo omitido: ${labelOf(s)}`;
export const fakeResult = (s: CodeSymbol): string => `fake:${labelOf(s)}`;

function effectiveAsync(model: ReplayModel, last: number): boolean[] {
  const eff = model.nodes.slice(0, last + 1).map((n) => n.async);
  for (let pass = 0; pass <= last; pass++) {
    for (let i = 0; i < last; i++) {
      const link = model.links[i]!;
      if (link.kind === "implements") {
        const both = eff[i]! || eff[i + 1]!;
        eff[i] = both;
        eff[i + 1] = both;
      } else if (eff[i + 1]) eff[i] = true;
    }
  }
  return eff;
}

/** The expressions a caller passes for the callee's needed parameters, in the callee's own order. */
function argumentsFor(model: ReplayModel, needs: Needs, i: number): string {
  const link = model.links[i]!;
  if (link.kind === "implements") return "";
  const callee = model.nodes[i + 1]!;
  return callee.params.flatMap((p, position) => (needs.params[i + 1]?.has(p.name) ? [link.args[position] ?? ""] : [])).join(", ");
}

function calleeExpression(model: ReplayModel, needs: Needs, i: number): string {
  const link = model.links[i]!;
  const callee = model.nodes[i + 1]!;
  const args = argumentsFor(model, needs, i);
  if (link.kind === "call") return `${callee.sym.symbol}(${args})`;
  if (link.kind === "self") return `this.${callee.sym.symbol}(${args})`;
  if (link.kind === "member") return `${[link.base.via === "field" ? "this" : "", link.base.name, ...link.path].filter(Boolean).join(".")}.${callee.external ? callee.external.members.at(-1) : callee.sym.symbol}(${args})`;
  return "";
}

const renderParams = (node: ReplayNode, needed: Set<string> | undefined): string =>
  node.params.filter((p) => needed?.has(p.name)).map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ");

export function emitProgram(index: RepositoryIndex, model: ReplayModel, last: number, guardLeaf: boolean): Program {
  const needs = computeNeeds(index, model, last, guardLeaf);
  const eff = effectiveAsync(model, last);
  const blocks: Block[] = [];
  const guardIndex = guardLeaf ? last : -1;
  const returns = (i: number): string => (eff[i] ? "Promise<string>" : "string");

  // Declared types the chain reads through (dependencies objects), copied member by member from the real source.
  for (const [name, members] of needs.typeMembers) {
    const decl = findTopLevel(index, name);
    const body = members.map((m) => `  ${m.name}${m.optional ? "?" : ""}: ${m.type};`).join("\n");
    const isInterface = decl ? isInterfaceDeclaration(index, decl.path, name) : true;
    blocks.push(isInterface ? { label: `interface ${name}`, text: `export interface ${name} {\n${body}\n}` } : { label: `type ${name}`, text: `export type ${name} = {\n${body}\n};` });
  }
  if (model.handlerAlias) blocks.push({ label: `type ${model.handlerAlias.name}`, text: `export type ${model.handlerAlias.name} = (${model.handlerAlias.requestParam}: Request) => Promise<string>;` });

  // Contracts: every chain method declared on the same interface lives in one interface.
  const contracts = new Map<string, number[]>();
  model.nodes.slice(0, last + 1).forEach((n, i) => {
    if (n.role === "contract") contracts.set(n.sym.container!, [...(contracts.get(n.sym.container!) ?? []), i]);
  });
  for (const [name, members] of contracts) {
    blocks.push({ label: `interface ${name}`, text: `export interface ${name} {\n${members.map((i) => `  ${model.nodes[i]!.sym.symbol}(): ${returns(i)};`).join("\n")}\n}` });
  }

  const bodyOf = (i: number): string[] => {
    const node = model.nodes[i]!;
    if (i === last) {
      const where = node.decl ? `// Corpo real omitido: ${node.decl.path}:${node.decl.startLine}-${node.decl.endLine}` : "// Corpo real omitido.";
      return [where, `return ${JSON.stringify(standIn(node.sym))};`];
    }
    const link = model.links[i]!;
    if (i + 1 === guardIndex) return [`if (!${model.nodes[guardIndex]!.sym.symbol}(${argumentsFor(model, needs, i)})) return "denied";`, `return "allowed";`];
    const expression = calleeExpression(model, needs, i);
    return [`return ${eff[i + 1] ? "await " : ""}${expression};`];
  };

  const done = new Set<string>();
  model.nodes.slice(0, last + 1).forEach((node, i) => {
    if (i === guardIndex || node.role === "contract" || node.role === "external") return;
    if (node.role === "function") {
      const lines = bodyOf(i).map((line) => `  ${line}`);
      const params = renderParams(node, needs.params[i]);
      if (i === 0 && model.handlerAlias) {
        const inner = bodyOf(i).map((line) => `    ${line}`).join("\n");
        blocks.push({ label: `function ${node.sym.symbol}`, text: `export function ${node.sym.symbol}(${params}): ${model.handlerAlias.name} {\n  return async (${model.handlerAlias.requestParam}: Request): Promise<string> => {\n${inner}\n  };\n}` });
        return;
      }
      blocks.push({ label: `function ${node.sym.symbol}`, text: `export ${eff[i] ? "async " : ""}function ${node.sym.symbol}(${params}): ${returns(i)} {\n${lines.join("\n")}\n}` });
      return;
    }
    const container = node.sym.container!;
    if (done.has(container)) return;
    done.add(container);
    const members = model.nodes.flatMap((n, j) => (j <= last && j !== guardIndex && n.role === "method" && n.sym.container === container ? [j] : []));
    const contract = members.map((j) => (model.links[j - 1]?.kind === "implements" ? model.nodes[j - 1]!.sym.container : undefined)).find(Boolean);
    const fields = needs.fields.get(container) ?? [];
    const constructorText = fields.length ? [`  constructor(${fields.map((f) => `private readonly ${f.name}${f.optional ? "?" : ""}: ${f.type}`).join(", ")}) {}`] : [];
    const methods = members.map((j) => {
      const inner = bodyOf(j).map((line) => `    ${line}`).join("\n");
      return `  ${eff[j] ? "async " : ""}${model.nodes[j]!.sym.symbol}(${renderParams(model.nodes[j]!, needs.params[j])}): ${returns(j)} {\n${inner}\n  }`;
    });
    blocks.push({ label: `class ${container}`, text: `export class ${container}${contract ? ` implements ${contract}` : ""} {\n${[...constructorText, ...methods].join("\n\n")}\n}` });
  });

  // The class of the repository that stands on an external one (`class PrismaService extends PrismaClient`).
  const external = model.nodes.slice(0, last + 1).find((n) => n.role === "external")?.external;
  if (external && external.dependency !== external.base) blocks.push({ label: `class ${external.dependency}`, text: `export class ${external.dependency} extends ${external.base} {}` });

  // Contracts and types first, then behaviour in the order the call travels.
  const order = (b: Block): number => (b.label.startsWith("type ") || b.label.startsWith("interface ") ? 0 : 1);
  blocks.sort((a, b) => order(a) - order(b));
  const imports = [...(guardLeaf ? [`import { ${model.nodes[guardIndex]!.sym.symbol} } from "./guard.ts";`] : []), ...(external ? [`import { ${external.base} } from "./${EXTERNAL_FILE}";`] : [])];
  const importLine = imports.length ? `${imports.join("\n")}\n\n` : "";
  const introduced = last > 0 ? model.links[last - 1]! : undefined;
  const callStatement = introduced && introduced.kind !== "implements" ? calleeExpression(model, needs, last - 1) : null;
  return { code: importLine + blocks.map((b) => b.text).join("\n\n") + "\n", blocks, callStatement, needs, effectiveAsync: eff };
}

// ---------------------------------------------------------------------------------------------
// Tests: the chain is exercised the way the real one is wired — by injecting collaborators.
// ---------------------------------------------------------------------------------------------

type Overrides = { members?: Record<string, string>; params?: Record<string, string> };

/** A value of a declared type, built from what the Replay itself declares: a class instance with its
 *  injected collaborators, a fake for a contract nobody implements yet, an object for a dependencies type. */
function valueOf(model: ReplayModel, program: Program, last: number, typeText: string, overrides: Overrides, depth = 0): string {
  const name = unwrapType(typeText);
  if (depth > 6) return "undefined";
  if (name === "Request") return `new Request("http://x")`;
  const nodes = model.nodes.slice(0, last + 1);
  // A type from the external package, or the class of the repository that extends it: nothing to inject.
  if (nodes.some((n) => n.external?.dependency === name)) return `new ${name}()`;
  const implementing = nodes.findIndex((n, i) => n.role === "method" && model.links[i - 1]?.kind === "implements" && model.nodes[i - 1]!.sym.container === name);
  const classIndex = implementing !== -1 ? implementing : nodes.findIndex((n) => n.role === "method" && n.sym.container === name);
  if (classIndex !== -1) {
    const container = nodes[classIndex]!.sym.container!;
    const args = (program.needs.fields.get(container) ?? []).map((f) => valueOf(model, program, last, f.type, overrides, depth + 1));
    return `new ${container}(${args.join(", ")})`;
  }
  const contract = nodes.filter((n) => n.role === "contract" && n.sym.container === name);
  if (contract.length) {
    const members = contract.map((n) => `${n.sym.symbol}: ${n.async ? "async " : ""}() => ${JSON.stringify(fakeResult(n.sym))}`);
    return `{ ${members.join(", ")} }`;
  }
  const members = program.needs.typeMembers.get(name);
  if (members) {
    const entries = members.flatMap((m) => {
      const override = overrides.members?.[m.name];
      if (override !== undefined) return override === "" ? [] : [`${m.name}: ${override}`];
      return m.optional ? [] : [`${m.name}: ${valueOf(model, program, last, m.type, overrides, depth + 1)}`];
    });
    return `{ ${entries.join(", ")} }`.replace("{  }", "{}");
  }
  return "undefined";
}

/** The call that enters the chain, with every needed argument built. */
export function entryCall(model: ReplayModel, program: Program, last: number, overrides: Overrides = {}): string {
  const entry = model.nodes[0]!;
  const args = entry.params
    .filter((p) => program.needs.params[0]?.has(p.name))
    .map((p) => overrides.params?.[p.name] ?? valueOf(model, program, last, p.type, overrides))
    .join(", ");
  if (model.handlerAlias) return `${entry.sym.symbol}(${args})(new Request("http://x"))`;
  if (entry.role === "method") {
    const fields = (program.needs.fields.get(entry.sym.container!) ?? []).map((f) => valueOf(model, program, last, f.type, overrides));
    return `new ${entry.sym.container}(${fields.join(", ")}).${entry.sym.symbol}(${args})`;
  }
  return `${entry.sym.symbol}(${args})`;
}

/** What entering the chain returns: the leaf's stand-in, or the fake's answer when the chain ends at a contract. */
export function expectedResult(model: ReplayModel, last: number): string {
  const leaf = model.nodes[last]!;
  return leaf.role === "contract" || leaf.role === "external" ? fakeResult(leaf.sym) : standIn(leaf.sym);
}

export function entrySymbolToImport(model: ReplayModel): string {
  const entry = model.nodes[0]!;
  return entry.role === "method" ? entry.sym.container! : entry.sym.symbol;
}

/** Names the test file must import from chain.ts: everything it constructs or calls. */
export function importsFor(model: ReplayModel, program: Program): string[] {
  const names = new Set<string>([entrySymbolToImport(model)]);
  for (const block of program.blocks) if (block.label.startsWith("class ")) names.add(block.label.slice("class ".length));
  return [...names].filter((name) => new RegExp(`\\b${name}\\b`).test(program.code));
}

/** The package's stand-in the learner is given (external.ts): the external type, reduced to the member the chain calls. */
export function externalStandIn(node: ReplayNode): string {
  const { base, module, members } = node.external!;
  const result = JSON.stringify(fakeResult(node.sym));
  const nest = (rest: string[]): string => (rest.length === 1 ? `{ ${rest[0]}: (): string => ${result} }` : `{ ${rest[0]}: ${nest(rest.slice(1))} }`);
  const body = members.length === 1 ? `  ${members[0]}(): string {\n    return ${result};\n  }` : `  ${members[0]} = ${nest(members.slice(1))};`;
  return `// Stand-in de "${module}": no código real, ${base} vem desse pacote, que não faz parte do repositório.\nexport class ${base} {\n${body}\n}\n`;
}

export function testFor(model: ReplayModel, program: Program, last: number): string {
  const title = labelOf(model.nodes[last]!.sym);
  const leaf = model.nodes[last]!;
  const via = leaf.role === "contract" ? " pelo contrato injetado" : "";
  // When the repository's own class is the external type itself, the test builds it from the package's stand-in.
  const standInImport = leaf.external && leaf.external.dependency === leaf.external.base ? [`import { ${leaf.external.base} } from "./${EXTERNAL_FILE}";`] : [];
  return [
    `import { test, expect } from "ownr:test";`,
    `import { ${importsFor(model, program).join(", ")} } from "./chain.ts";`,
    ...standInImport,
    `test(${JSON.stringify(`alcança ${title}${via}`)}, async () => { expect(await ${entryCall(model, program, last)}).toBe(${JSON.stringify(expectedResult(model, last))}); });`,
  ].join("\n");
}

/** The guard chain's tests: the real guard decides on the real header, wired through the dependencies object. */
export function guardTests(model: ReplayModel, program: Program, last: number): string {
  const reqParam = model.nodes[0]!.params.find((p) => p.type === "Request")?.name ?? "req";
  const call = (headers: string, apiKey: string | null): string =>
    entryCall(model, program, last, { params: { [reqParam]: `new Request("http://x"${headers})` }, members: { apiKey: apiKey ?? "" } });
  const wrong = `, { headers: { "x-api-key": "wrong" } }`;
  const right = `, { headers: { "x-api-key": "secret" } }`;
  return [
    `import { test, expect } from "ownr:test";`,
    `import { ${importsFor(model, program).join(", ")} } from "./chain.ts";`,
    `test("permite sem chave configurada", async () => { expect(await ${call("", null)}).toBe("allowed"); });`,
    `test("nega chave incorreta", async () => { expect(await ${call(wrong, '"secret"')}).toBe("denied"); });`,
    `test("permite chave correta", async () => { expect(await ${call(right, '"secret"')}).toBe("allowed"); });`,
  ].join("\n");
}
