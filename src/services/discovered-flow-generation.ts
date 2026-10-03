import type { Declaration, RepositoryIndex } from "./code-map.ts";
import { discoverFlow, entryShape, escapeRegExp, interfaceImplementations, type CodeSymbol, type ExternalCall, type FlowEdge, type FlowIntent } from "./flow-discovery.ts";
import { buildModel, emitProgram, EXTERNAL_FILE, externalStandIn, guardTests, testFor, type Block, type Program, type ReplayModel, type ReplayNode } from "./flow-replay.ts";
import type { Journey } from "../domain/journey.ts";
import { noveltyLines } from "../domain/line-diff.ts";
import { Stage, type CodeFile, type OriginalCodeReference } from "../domain/stage.ts";
import type { ArchitectureGraph } from "../domain/architecture.ts";
import { stageNarrative } from "./stage-narrative.ts";

/**
 * Turns a flow discovered by static analysis (src/services/flow-discovery.ts) into a runnable
 * micro-journey — one micro stage per real, verified node of the chain, for a chain of WHATEVER
 * length discovery found. Nothing here is a per-goal recipe.
 *
 * The Replay code of every stage comes from src/services/flow-replay.ts, which keeps the real
 * STRUCTURE (interfaces stay interfaces, dependencies are received and called through, classes
 * implement what they implement) and simplifies only data. A stage is one node of the chain, so
 * "depend on a contract" and "implement that contract" are separate stages, each small.
 *
 * A chain may END on an interface method when the pinned source has several classes (or none)
 * implementing it: which one runs depends on runtime wiring a static reader cannot decide. That
 * last stage is taught as the contract itself, naming the implementations found and saying plainly
 * that the chain stops there — it never picks one. A contract whose own file is not in the indexed
 * source is declared as an interface reduced to the method used, and the narrative says so.
 *
 * One code SHAPE is special-cased, and it is structural, not a domain: a "guard" — the final symbol
 * returns `boolean` and the discovered call is a real `if (!guard(...))` early return. Its logic is
 * reused verbatim from the real source (never simulated) so the exercise runs the exact comparison.
 */

export type DiscoveredFlowPlan = { kind: "discovered-flow"; intent: FlowIntent; goal: string; moduleId: "flow"; chain: CodeSymbol[]; edges: FlowEdge[]; external: ExternalCall | null };

export function planDiscoveredFlow(goal: string, intent: FlowIntent, index: RepositoryIndex): DiscoveredFlowPlan {
  const found = discoverFlow(goal, index, intent);
  if (found.chain.length < 2) {
    throw new Error(`O grafo descoberto para "${goal}" não conecta o ponto de entrada a nenhum outro símbolo comprovado.`);
  }
  return { kind: "discovered-flow", intent, goal, moduleId: "flow", chain: found.chain, edges: found.edges, external: found.external };
}

function snippetOf(index: RepositoryIndex, d: Declaration): string {
  return (index.files.get(d.path) ?? "").split("\n").slice(d.startLine - 1, d.endLine).join("\n");
}

const labelOf = (node: CodeSymbol): string => (node.container ? `${node.container}.${node.symbol}` : node.symbol);

function reference(index: RepositoryIndex, journey: Journey, d: Declaration, note: string): OriginalCodeReference {
  return {
    path: d.path,
    symbol: d.symbol,
    startLine: d.startLine,
    endLine: d.endLine,
    replayFile: "chain.ts",
    note,
    snippet: snippetOf(index, d),
    url: `${journey.repo.url}/blob/${journey.repo.sha}/${d.path}#L${d.startLine}-L${d.endLine}`,
  };
}

/** What the analysis could not prove past a terminal contract, in words a learner can check. */
function contractBoundary(index: RepositoryIndex, contract: CodeSymbol): string {
  const implementations = interfaceImplementations(index, contract) ?? [];
  const found = implementations.length ? `o SHA fixado tem ${implementations.length} implementações (${implementations.join(", ")})` : "o SHA fixado não tem nenhuma classe que a implemente";
  return `${found}; qual delas roda depende de como o servidor é montado, algo que a análise estática não decide. Por isso a cadeia termina neste contrato, sem escolher uma implementação.`;
}

/** What the analysis could not prove past a call into an external package, in words a learner can check. */
function externalBoundaryText(external: Pick<ExternalCall, "base" | "module" | "members">): string {
  return `${external.members.join(".")} é um membro de ${external.base}, do pacote "${external.module}", que não faz parte do SHA fixado: a análise estática não vê o que ele faz. Por isso a cadeia termina nessa chamada, sem simular o que existe do outro lado.`;
}

const oneLine = (text: string): string => text.replace(/,(\s*[}\]])/g, "$1").replace(/\s+/g, " ").trim();

type GuardInfo = { guardDecl: Declaration; edge: FlowEdge };

function detectGuard(index: RepositoryIndex, last: FlowEdge): GuardInfo | null {
  const guardDecl = index.declarations.find((d) => d.path === last.to.path && d.symbol === last.to.symbol && d.container === last.to.container);
  if (!guardDecl) return null;
  const signature = (index.files.get(guardDecl.path) ?? "").split("\n")[guardDecl.startLine - 1] ?? "";
  if (!/\)\s*:\s*boolean\b/.test(signature)) return null;
  if (!new RegExp(`if\\s*\\(!\\s*${escapeRegExp(last.to.symbol)}\\s*\\(`).test(last.snippet)) return null;
  return { guardDecl, edge: last };
}

/** Real nodes only: a contract whose file is not indexed has nothing on the map to resolve to. Labels are
 *  bare declared names (a class, an interface or a function), the only form resolveNode matches. */
function architectureFor(model: ReplayModel, upto: number): ArchitectureGraph {
  const ids = new Map<string, string>();
  const nodes: ArchitectureGraph["nodes"] = [];
  model.nodes.slice(0, upto + 1).forEach((node, i) => {
    if (!node.decl) return;
    const label = node.sym.container ?? node.sym.symbol;
    if (ids.has(label)) return;
    ids.set(label, `n${i}`);
    nodes.push({ id: `n${i}`, label, kind: node.role === "contract" ? "interface" : node.role === "method" ? "class" : "function", col: Math.min(nodes.length, 8), row: 0 });
  });
  const idOf = (node: ReplayNode): string | undefined => (node.decl ? ids.get(node.sym.container ?? node.sym.symbol) : undefined);
  const edges: ArchitectureGraph["edges"] = [];
  model.links.slice(0, upto).forEach((link, i) => {
    const from = model.nodes[i]!;
    const to = model.nodes[i + 1]!;
    // An edge joins two real symbols: a contract outside the indexed source is not on the map, so it links nothing.
    const [a, b] = link.kind === "implements" ? [idOf(to), idOf(from)] : [idOf(from), idOf(to)];
    const rel = link.kind === "implements" ? "implements" : "calls";
    if (a && b && a !== b && !edges.some((e) => e.from === a && e.to === b && e.rel === rel)) edges.push({ from: a, to: b, rel });
  });
  return { nodes, edges };
}

const SIMPLIFICATION = "Simplificações do Replay: os dados foram reduzidos (cada função devolve uma string; o real trafega objetos e Response) e só ficaram os parâmetros que carregam dependências.";

function phrase(label: string): string {
  const [kind, name] = label.split(" ") as [string, string];
  return `${{ interface: "a interface", class: "a classe", type: "o tipo", function: "a função" }[kind] ?? kind} ${name}`;
}

type StepText = { title: string; need: string; task: string; outcome: string; code: string; detail: string; preserved: string; requirement: string };

/** The narrative of one step, by the STRUCTURAL relation the real call site proves. */
function describeStep(model: ReplayModel, i: number, program: Program, added: Block[], boundary: string, isGuardHop: boolean): StepText {
  const caller = model.nodes[i - 1]!;
  const node = model.nodes[i]!;
  const link = model.links[i - 1]!;
  const A = labelOf(caller.sym);
  const B = labelOf(node.sym);
  const container = caller.sym.container ?? "";
  const expression = program.callStatement ?? B;
  const declare = added.length ? `declare ${added.map((b) => phrase(b.label)).join(", ")} e ` : "";
  const site = link.kind === "implements" ? "" : `No SHA fixado, ${A} chama ${B} em ${caller.sym.path}:${link.line}: \`${link.snippet}\`.`;
  const virtual = node.role === "contract" && node.decl === null ? " O arquivo desse contrato não está entre os fontes indexados do SHA fixado; o Replay o declara como interface, reduzida ao método usado." : "";
  const terminal = node.role === "contract" && i === model.nodes.length - 1;

  if (link.kind === "implements") {
    const I = caller.sym.container ?? "";
    const Impl = node.sym.container ?? "";
    return {
      title: `Implementar ${I} em ${Impl}`,
      need: `No código real, ${Impl} implementa o contrato ${I}: é a única classe do SHA fixado que o cumpre, e quem chama depende só do contrato.`,
      task: `${declare}faça ${Impl} implementar ${I}.`,
      outcome: `o contrato ${I} passa a ter uma implementação real: ${Impl}.`,
      code: `${Impl} implements ${I} cumpre o contrato com o método ${node.sym.symbol}.`,
      detail: `No SHA fixado, ${Impl} implementa ${I}: \`${link.snippet}\`.`,
      preserved: "a classe que implementa a interface, separada dela",
      requirement: `${Impl} deve implementar ${I}.`,
    };
  }
  if (node.role === "external" && link.kind === "member") {
    const ext = node.external!;
    const receiver = [link.base.via === "field" ? "this" : "", link.base.name, ...link.path].filter(Boolean).join(".");
    const call = `${receiver}.${ext.members.at(-1)}`;
    const ownClass = ext.dependency !== ext.base;
    const origin = ownClass ? `${ext.dependency}, uma classe do repositório que estende ${ext.base}, importado do pacote "${ext.module}"` : `${ext.base}, importado do pacote "${ext.module}"`;
    const how = link.base.via === "field" ? `faça ${container} receber ${link.base.name} pelo construtor e ${A} chamar ${call} através dele` : `faça ${A} receber ${link.base.name} como parâmetro e chamar ${call} através dele`;
    return {
      title: `Chamar ${ext.members.join(".")} de ${ext.base}`,
      need: `No código real, ${link.base.via === "field" ? `${container} recebe ${link.base.name} pelo construtor (injeção de dependência)` : `${A} recebe ${link.base.name} como parâmetro`}, do tipo ${origin}. ${A} chama ${call}(...): o membro ${ext.members.join(".")} não é declarado pelo repositório, vem de ${ext.base}.`,
      task: `${declare}${how}.${ownClass ? ` ${ext.dependency} estende ${ext.base}, que o Replay recebe pronto em ${EXTERNAL_FILE}.` : ` ${ext.base} vem pronto em ${EXTERNAL_FILE}.`}`,
      outcome: `a cadeia chega à chamada ${call}, onde termina o que o código do repositório prova.`,
      code: `${A} chama ${expression} e devolve o resultado.`,
      detail: `No SHA fixado, ${A} chama ${call} em ${caller.sym.path}:${link.line}: \`${link.snippet}\`, passando \`${oneLine(ext.argsText)}\`. A assinatura real é \`${ext.signature}\`. Neste ponto, ${externalBoundaryText(ext)}`,
      preserved: `a dependência injetada pelo construtor e a classe que estende o tipo do pacote externo; o pacote em si não está no repositório`,
      requirement: `${how.charAt(0).toUpperCase()}${how.slice(1)}.`,
    };
  }
  if (isGuardHop) {
    return {
      title: `Verificar ${B} antes de continuar`,
      need: `No código real, ${A} só continua se ${B} autorizar a requisição.`,
      task: `chame ${B} dentro de ${A} e negue a continuação quando ele devolver falso.`,
      outcome: `a requisição só é permitida quando ${B} confirma o acesso.`,
      code: `if (!${expression}) return "denied"; do contrário, devolve "allowed".`,
      detail: site,
      preserved: "a função de guarda real, com a comparação idêntica à do código",
      requirement: `${A} deve negar a continuação quando ${B} devolver falso.`,
    };
  }
  if (link.kind === "call") {
    return {
      title: `Encaminhar para ${B}`,
      need: `No código real, ${A} chama ${B} para continuar o fluxo.`,
      task: `${declare}faça ${A} chamar ${B}.`,
      outcome: `a cadeia chega a ${B}, o componente real relevante para o objetivo.`,
      code: `${A} chama ${expression} e devolve o resultado.`,
      detail: site,
      preserved: "uma função chamando outra, como no código real",
      requirement: `${A} deve chamar ${B}.`,
    };
  }
  if (link.kind === "self") {
    return {
      title: `Encaminhar para ${B}`,
      need: `No código real, ${A} chama outro método da mesma classe, ${B}, por this.`,
      task: `${declare}faça ${A} chamar ${B} por this.`,
      outcome: `a cadeia chega a ${B}, na mesma classe.`,
      code: `${A} chama ${expression} e devolve o resultado.`,
      detail: site,
      preserved: "métodos da mesma classe, um chamando o outro por this",
      requirement: `${A} deve chamar ${B} por this.`,
    };
  }
  // A call through a dependency the caller RECEIVES: never constructed by the caller.
  const receiver = [link.base.via === "field" ? "this" : "", link.base.name, ...link.path].filter(Boolean).join(".");
  const received =
    link.base.via === "field"
      ? `${container} recebe ${link.base.name} pelo construtor (injeção de dependência) e ${A} chama ${receiver}.${node.sym.symbol}`
      : `${A} não constrói o que usa: recebe ${link.base.name}, um objeto de dependências, e chama ${receiver}.${node.sym.symbol}`;
  const how = link.base.via === "field" ? `faça ${container} receber ${link.base.name} pelo construtor e ${A} chamar ${B} através dele` : `faça ${A} receber ${link.base.name} como parâmetro e chamar ${B} através dele`;
  const preserved = `${link.base.via === "field" ? "a dependência injetada pelo construtor e chamada por this" : "a dependência recebida como parâmetro e chamada através dele"}${node.role === "contract" ? "; a interface continua sendo uma interface" : ""}`;
  const requirement = `${how.charAt(0).toUpperCase()}${how.slice(1)}.`;
  if (node.role === "contract") {
    return {
      title: `Depender do contrato ${node.sym.container}`,
      need: `No código real, ${received}: depende só do contrato ${node.sym.container}, uma interface, nunca de uma classe concreta.${virtual}`,
      task: `${declare}${how}.`,
      outcome: terminal ? `a cadeia chega ao contrato ${B}, onde a chamada é comprovada mas a implementação não.` : `${A} passa a depender do contrato ${node.sym.container}, não de uma implementação.`,
      code: `${A} chama ${expression} e devolve o resultado.`,
      detail: `${site}${terminal ? ` Neste ponto, ${boundary}` : ""}`,
      preserved,
      requirement,
    };
  }
  return {
    title: `Encaminhar para ${B}`,
    need: `No código real, ${received}.`,
    task: `${declare}${how}.`,
    outcome: `a cadeia chega a ${B}, o componente real relevante para o objetivo.`,
    code: `${A} chama ${expression} e devolve o resultado.`,
    detail: site,
    preserved,
    requirement,
  };
}

export function generateDiscoveredFlow(plan: DiscoveredFlowPlan, journey: Journey, index: RepositoryIndex): Stage[] {
  const model = buildModel(index, plan.chain, plan.edges, plan.external);
  const last = model.nodes.length - 1;
  if (last < 1) throw new Error("O grafo descoberto não tem nenhum passo executável a ensinar.");
  const guard = plan.external ? null : detectGuard(index, plan.edges.at(-1)!);
  const programs: Program[] = [];
  for (let i = 1; i <= last; i++) programs[i] = emitProgram(index, model, i, Boolean(guard) && i === last);

  const entry = model.nodes[0]!;
  const entryLabel = labelOf(entry.sym);
  // What travels through the chain: a request entering the system (trace_request), or just a call (other).
  const subject = plan.intent === "trace_request" ? "requisição" : "chamada";
  const targetLabel = labelOf(model.nodes[last]!.sym);
  const entryIntro =
    plan.intent === "other"
      ? `Este percurso começa em ${entryLabel}, o símbolo mais externo ligado ao objetivo: nenhum outro símbolo relacionado ao objetivo o chama nas chamadas comprovadas do código. Daí, só chamadas comprovadas levam até ${targetLabel}.`
      : entryShape(index, plan.chain[0]!) === "handler-factory"
        ? `${entry.sym.symbol} cria o handler HTTP deste servidor, a função que recebe cada requisição; o Replay reproduz a fábrica e o handler que ela devolve.`
        : `A requisição chega em ${entry.sym.symbol}, o ponto de entrada HTTP deste servidor.`;

  const support: CodeFile[] = [];
  // The package a chain leaves the repository through is given to the learner, reduced to what the chain calls.
  const leafNode = model.nodes[last]!;
  if (leafNode.role === "external") support.push({ path: EXTERNAL_FILE, content: externalStandIn(leafNode) });
  let guardSource = "";
  if (guard) {
    guardSource = snippetOf(index, guard.guardDecl).replace(/^(async\s+)?function\s+/, (match) => `export ${match}`);
    support.push({ path: "guard.ts", content: `${guardSource}\n` });
  }

  const stages: Stage[] = [];
  let previousLimitation = `${entryLabel} ainda não encaminha a ${subject} para ninguém.`;

  for (let i = 1; i <= last; i++) {
    const node = model.nodes[i]!;
    const caller = model.nodes[i - 1]!;
    const link = model.links[i - 1]!;
    const program = programs[i]!;
    const before = i === 1 ? undefined : programs[i - 1]!;
    const isFinal = i === last;
    const isGuardHop = Boolean(guard) && isFinal;
    const solutionContent = program.code;
    const starterContent = before?.code ?? "";
    const added = program.blocks.filter((block) => !before?.blocks.some((b) => b.label === block.label));
    const text = describeStep(model, i, program, added, node.role === "contract" ? contractBoundary(index, node.sym) : "", isGuardHop);

    const narrative = stageNarrative({
      previous: i === 1 ? entryIntro : `Na etapa anterior, a cadeia chegou a ${labelOf(caller.sym)}.`,
      need: text.need,
      limitation: previousLimitation,
      task: text.task,
      outcome: text.outcome,
      code: text.code,
      detail: `${text.detail} ${SIMPLIFICATION} Preservado do real: ${text.preserved}.`,
    });
    const limitation = isFinal
      ? "Agora reconstrua o encadeamento inteiro sem o ponto de partida."
      : node.role === "contract"
        ? `${node.sym.container} é só um contrato: ainda falta a classe que o cumpre.`
        : `${labelOf(node.sym)} ainda não encaminha a ${subject} para o próximo passo real.`;

    const refs: OriginalCodeReference[] = [];
    if (isGuardHop && caller.decl) refs.push(reference(index, journey, caller.decl, `O Replay reduz ${labelOf(caller.sym)} à decisão de acesso; o código real também roteia as demais operações da API.`));
    if (link.kind === "implements" && caller.decl) refs.push(reference(index, journey, caller.decl, `${caller.sym.container} é a interface que ${node.sym.container} implementa.`));
    if (node.role === "external" && caller.decl) {
      refs.push(reference(index, journey, caller.decl, `Corpo real de ${labelOf(caller.sym)}: a chamada ao pacote externo e os dados que ela recebe; o Replay a reduz à chamada.`));
      const dependencyDecl = index.declarations.find((d) => d.container === null && d.symbol === node.external!.dependency);
      if (dependencyDecl) refs.push(reference(index, journey, dependencyDecl, `${dependencyDecl.symbol} no código real: o Replay a reduz a \`extends ${node.external!.base}\`, que vem do pacote \`${node.external!.module}\`.`));
    }
    if (node.decl) {
      const note = isGuardHop
        ? `O Replay reexporta ${labelOf(node.sym)} sem alterar a lógica: a comparação é idêntica à do código real.`
        : node.role === "contract"
          ? "Assinatura do contrato, sem corpo: quem chama depende só dela, não de uma classe concreta."
          : `O Replay preserva a estrutura e omite o corpo de ${labelOf(node.sym)}; o comportamento completo está neste trecho real, não executado nesta etapa.`;
      refs.push(reference(index, journey, node.decl, note));
    }
    for (const name of program.needs.typeMembers.keys()) {
      if (before?.needs.typeMembers.has(name)) continue;
      const decl = index.declarations.find((d) => d.container === null && d.symbol === name);
      if (decl) refs.push(reference(index, journey, decl, `O Replay reduz ${name} aos membros que a cadeia usa, com os mesmos tipos do código real.`));
    }

    const guardName = model.nodes[last]!.sym.symbol;
    const lineMatch = isGuardHop ? `if (!${guardName}(` : link.kind === "implements" ? `implements ${caller.sym.container}` : program.callStatement && solutionContent.includes(program.callStatement) ? program.callStatement : undefined;
    const novelty = noveltyLines(starterContent, solutionContent).length;
    const changedPieces = added.map((b) => b.label).join(", ");

    const stage = Stage.parse({
      id: `${journey.id}.flow-${String(i).padStart(2, "0")}`,
      order: i,
      moduleId: plan.moduleId,
      kind: "micro",
      // The stage puts several real pieces of ONE relation together; splitting it would mean inventing an
      // intermediate structure that does not exist in the code, so the justification is explicit.
      ...(novelty > 5 ? { noveltyException: `Fidelidade à estrutura real: esta etapa reúne as peças de uma mesma relação (${changedPieces || "ajustes de assinatura"}, mais as assinaturas que passam a carregar a dependência); dividi-la exigiria inventar uma estrutura intermediária que o código real não tem.` } : {}),
      title: text.title,
      goal: isGuardHop ? "Aprender que uma função de guarda decide, com um booleano, se a ação protegida pode continuar." : `Aprender como ${labelOf(caller.sym)} alcança ${labelOf(node.sym)} na estrutura real: ${text.preserved}.`,
      context: narrative.context,
      problem: narrative.problem,
      examples: [],
      requirements: [],
      estimatedMinutes: isFinal ? 3 : 2,
      introduces: [],
      prerequisites: [],
      architecture: architectureFor(model, i),
      referenceCode: [{ path: "chain.ts", content: solutionContent }],
      lineNotes: lineMatch ? [{ match: lineMatch, note: narrative.quick }] : [],
      explanation: [{ id: `flow-${i}`, title: labelOf(node.sym), quick: narrative.quick, normal: narrative.normal }],
      originalCodeRefs: refs,
      exercise: {
        instructions: isGuardHop
          ? `Importe ${guardName} de guard.ts. Dentro de ${labelOf(caller.sym)}, devolva "denied" quando ${program.callStatement ?? guardName} for falso; senão devolva "allowed".`
          : `Reproduza a estrutura real: ${text.task.charAt(0).toUpperCase()}${text.task.slice(1)} Cada função devolve uma string; o corpo real fica omitido.`,
        starterFiles: [{ path: "chain.ts", content: starterContent }],
        solutionFiles: [{ path: "chain.ts", content: solutionContent }],
        supportFiles: isFinal ? support : [],
        expose: [],
        testFile: { path: "tests.ts", content: isGuardHop ? guardTests(model, program, i) : testFor(model, program, i) },
      },
      toolbox: isGuardHop ? [{ id: "guard", name: labelOf(node.sym), summary: "Função real do repositório usada nesta etapa.", example: guardSource }] : [],
      tutorContext: { relevantFiles: ["chain.ts", ...(isGuardHop ? ["guard.ts"] : []), ...(node.decl ? [node.decl.path] : [])], concepts: [], previousStages: stages.map((s) => s.id) },
      completionCriteria: [{ kind: "tests_pass" }],
      limitation,
      summary: { added: added.length ? added.map((b) => b.label.split(" ")[1] ?? b.label) : [labelOf(node.sym)], why: narrative.problem, flow: model.nodes.slice(0, i + 1).map((n) => labelOf(n.sym)) },
    });
    stages.push(stage);
    previousLimitation = limitation;
  }

  const stepsNarrative = model.links
    .map((link, i) => {
      const from = model.nodes[i]!;
      const to = model.nodes[i + 1]!;
      if (link.kind === "implements") return `${to.sym.container} implementa ${from.sym.container} (\`${link.snippet}\`)`;
      if (to.role === "external" && link.kind === "member") return `${labelOf(from.sym)} chama ${[link.base.via === "field" ? "this" : "", link.base.name, ...link.path].filter(Boolean).join(".")}.${to.sym.symbol.split(".").at(-1)} em ${from.sym.path}:${link.line} (\`${link.snippet}\`)`;
      return `${labelOf(from.sym)} chama ${labelOf(to.sym)} em ${from.sym.path}:${link.line} (\`${link.snippet}\`)`;
    })
    .join("; depois, ");
  const leaf = model.nodes[last]!;
  const tail =
    leaf.role === "external"
      ? ` A chamada recebe \`${oneLine(leaf.external!.argsText)}\`, montado a partir dos parâmetros da assinatura real \`${leaf.external!.signature}\`. ${externalBoundaryText(leaf.external!)}`
      : leaf.role === "contract"
      ? ` ${labelOf(leaf.sym)} é um contrato sem corpo: ${contractBoundary(index, leaf.sym)}`
      : guard
        ? ` ${labelOf(leaf.sym)} compara o cabeçalho x-api-key com a chave configurada e só nega quando uma chave está configurada e não bate; sem chave configurada, tudo é permitido.`
        : ` O comportamento completo de ${labelOf(leaf.sym)} está no trecho de código real referenciado na etapa anterior (não executado aqui: depende de infraestrutura que este sandbox não provê).`;

  const { noveltyException: _dropped, ...finalStage } = stages.at(-1)!;
  void _dropped;
  const checkpoint = Stage.parse({
    ...finalStage,
    id: `${journey.id}.flow-99`,
    order: stages.length + 1,
    kind: "checkpoint",
    title: "Checkpoint: reconstrua a cadeia descoberta",
    goal: `Reconstruir ${model.nodes.map((n) => labelOf(n.sym)).join(" -> ")} do editor vazio, com a mesma estrutura do código real.`,
    context: "Todas as peças foram introduzidas uma a uma.",
    problem: `Agora reconstrua a cadeia inteira: ${model.nodes.map((n) => labelOf(n.sym)).join(" -> ")}. Preserve interfaces, dependências recebidas e implementações como no código real.`,
    requirements: model.nodes.slice(1).map((_node, i) => describeStep(model, i + 1, programs[i + 1]!, [], "", Boolean(guard) && i + 1 === last).requirement),
    exercise: { ...finalStage.exercise!, starterFiles: [{ path: "chain.ts", content: "" }] },
    tutorContext: { ...finalStage.tutorContext, previousStages: stages.map((s) => s.id) },
    checkpoint: {
      question: `Como a chamada chega de ${entryLabel} até ${targetLabel}, e o que o código real faz nesse ponto?`,
      answer: `No SHA fixado: ${stepsNarrative}.${tail} O Replay preserva a estrutura real (interfaces, injeção de dependência e implementações) e reduz apenas os dados.`,
    },
    limitation: undefined,
    summary: { added: model.nodes.map((n) => labelOf(n.sym)), why: plan.intent === "trace_request" ? "Conectar o ponto de entrada HTTP ao componente real relevante para o objetivo." : "Conectar o ponto de partida técnico ao componente real relevante para o objetivo.", flow: model.nodes.map((n) => labelOf(n.sym)) },
  });

  return [...stages, checkpoint];
}
