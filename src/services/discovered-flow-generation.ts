import type { Declaration, RepositoryIndex } from "./code-map.ts";
import { discoverFlow, escapeRegExp, isInterfaceDeclaration, type CodeSymbol, type FlowEdge } from "./flow-discovery.ts";
import type { Journey } from "../domain/journey.ts";
import { Stage, type CodeFile, type OriginalCodeReference } from "../domain/stage.ts";
import type { ArchitectureGraph } from "../domain/architecture.ts";
import { stageNarrative } from "./stage-narrative.ts";

/**
 * Turns a flow discovered by static analysis (src/services/flow-discovery.ts) into a runnable
 * micro-journey — one micro stage per real, verified STEP, for a chain of WHATEVER length
 * discovery found (no fixed node count, no restriction to any single code shape). Nothing here
 * is a per-goal recipe: the same code path produced the authentication journey (a boolean guard
 * clause, two hops) and the persistence journey (five hops through a service, an interface
 * contract, its one real implementation, and the function that performs the write), and will
 * produce whatever else future goals resolve to.
 *
 * A discovered chain may pass through an INTERFACE on its way to a concrete implementation
 * (`TriageRunRepository.complete` -> `PrismaTriageRunRepository.complete`, joined by discovery's
 * "implements" edge). An interface has no body to run, so it is never turned into Replay code by
 * itself — it is folded into the SAME step as the concrete implementation that follows it, and
 * the step's narrative explicitly teaches the distinction: the caller depends on a contract, and
 * exactly one real class fulfils it in the pinned source.
 *
 * Two generic hop patterns are recognised for a step's own code:
 *  - a "guard" step: the final symbol returns `boolean` and the discovered edge into it is a real
 *    `if (!guard(...))` early return — its logic is reused verbatim (never simulated) so the
 *    exercise executes the exact real comparison.
 *  - a plain "relay" step (the default for everything else): the Replay reduces the callee to a
 *    marker string confirming the real call was reached; the callee's actual behaviour is cited,
 *    verified and unexecuted, via `originalCodeRefs` and the checkpoint's explanation. This keeps
 *    the exercise honest (no fabricated business behaviour) for symbols whose real logic needs
 *    infrastructure (a database, a network call) this sandbox cannot honestly run.
 */

export type DiscoveredFlowPlan = { kind: "discovered-flow"; goal: string; moduleId: "flow"; chain: CodeSymbol[]; edges: FlowEdge[] };

export function planDiscoveredFlow(goal: string, journey: Journey, index: RepositoryIndex): DiscoveredFlowPlan {
  if (journey.repo.owner !== "marcelotaparelli" || journey.repo.name !== "ops-triage-ai") {
    throw new Error("Este gerador atende somente o repositório acompanhado nesta jornada.");
  }
  const found = discoverFlow(goal, index);
  if (found.chain.length < 2) {
    throw new Error(`O grafo descoberto para "${goal}" não conecta o ponto de entrada a nenhum outro símbolo comprovado.`);
  }
  return { kind: "discovered-flow", goal, moduleId: "flow", chain: found.chain, edges: found.edges };
}

function declarationOf(index: RepositoryIndex, s: CodeSymbol): Declaration {
  const d = index.declarations.find((decl) => decl.path === s.path && decl.symbol === s.symbol && decl.container === s.container);
  if (!d) throw new Error(`Declaração ${s.symbol} ausente no SHA fixado.`);
  return d;
}

function snippetOf(index: RepositoryIndex, d: Declaration): string {
  return (index.files.get(d.path) ?? "").split("\n").slice(d.startLine - 1, d.endLine).join("\n");
}

/** For narrative text only — architecture node labels and originalCodeRefs.symbol must stay the
 *  bare declared name (see below), since that is what the rest of the system resolves against. */
function displayLabel(node: CodeSymbol): string {
  return node.container ? `${node.container}.${node.symbol}` : node.symbol;
}

function isInterfaceNode(index: RepositoryIndex, node: CodeSymbol): boolean {
  return node.container !== null && isInterfaceDeclaration(index, node.path, node.container);
}

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

/** One taught step: reaching `to`, via one or more real edges. More than one edge means the call
 *  passed through an interface's contract before landing on its one real implementation. */
type Step = { to: CodeSymbol; edges: FlowEdge[] };

/** Interfaces have no body of their own to teach as a separate stage — a hop that lands on one is
 *  folded into the SAME step as whatever comes next, so every step ends on real, runnable code. */
function collapseIntoSteps(index: RepositoryIndex, chain: CodeSymbol[], edges: FlowEdge[]): Step[] {
  const steps: Step[] = [];
  let pending: FlowEdge[] = [];
  for (let i = 0; i < edges.length; i++) {
    pending.push(edges[i]!);
    const node = chain[i + 1]!;
    if (!isInterfaceNode(index, node)) {
      steps.push({ to: node, edges: pending });
      pending = [];
    }
  }
  return steps;
}

type GuardInfo = { guardDecl: Declaration; edge: FlowEdge };

/**
 * The only code SHAPE this generator special-cases, and it is a generic structural pattern
 * (boolean function gating an early return), not a domain: it happens to fire for authentication
 * because that is what the discovered symbol looks like in this repository, not because the
 * generator knows what "authentication" means.
 */
function detectGuard(index: RepositoryIndex, lastStep: Step): GuardInfo | null {
  const last = lastStep.edges.at(-1)!;
  const guardDecl = index.declarations.find((d) => d.path === last.to.path && d.symbol === last.to.symbol && d.container === last.to.container);
  if (!guardDecl) return null;
  const signature = (index.files.get(guardDecl.path) ?? "").split("\n")[guardDecl.startLine - 1] ?? "";
  if (!/\)\s*:\s*boolean\b/.test(signature)) return null;
  if (!new RegExp(`if\\s*\\(!\\s*${escapeRegExp(last.to.symbol)}\\s*\\(`).test(last.snippet)) return null;
  return { guardDecl, edge: last };
}

function flowArchitecture(declarableChain: CodeSymbol[], uptoIndex: number): ArchitectureGraph {
  // Node labels must be the bare declared symbol (never "Container.method"): that is the only
  // form src/services/code-map.ts's resolveNode can match against real declarations.
  const nodes = declarableChain.slice(0, uptoIndex + 1).map((node, i) => ({ id: `n${i}`, label: node.symbol, kind: node.container ? ("class" as const) : ("function" as const), col: i, row: 0 }));
  const edges = nodes.slice(1).map((node, i) => ({ from: `n${i}`, to: node.id, rel: "calls" as const }));
  return { nodes, edges };
}

export function generateDiscoveredFlow(plan: DiscoveredFlowPlan, journey: Journey, index: RepositoryIndex): Stage[] {
  const { chain } = plan;
  const steps = collapseIntoSteps(index, chain, plan.edges);
  if (!steps.length) throw new Error("O grafo descoberto não tem nenhum passo executável a ensinar.");
  const declarableChain = [chain[0]!, ...steps.map((step) => step.to)];
  const declarations = declarableChain.map((node) => declarationOf(index, node));
  const guard = detectGuard(index, steps.at(-1)!);
  const entrySymbol = chain[0]!.symbol;

  // A guarded chain keeps the (req, apiKey) shape the real guard needs; anything else uses a
  // generic single string argument threaded through the chain — there is nothing left to teach
  // about that argument itself, only about which real symbol gets reached.
  const params = guard ? "req: Request, apiKey: string | undefined" : "input: string";
  const args = guard ? "req, apiKey" : "input";

  const callExpr = (node: CodeSymbol): string => (node.container === null ? `${node.symbol}(${args})` : `new ${node.container}().${node.symbol}(${args})`);
  const declSnippet = (node: CodeSymbol, body: string): string =>
    node.container === null
      ? `export async function ${node.symbol}(${params}): Promise<string> {\n  ${body}\n}`
      : `export class ${node.container} {\n  async ${node.symbol}(${params}): Promise<string> {\n    ${body}\n  }\n}`;
  // The guard target itself is never re-declared in chain.ts: it lives in guard.ts and is only
  // imported. What chain.ts declares, up to a given stage, is every OTHER node reached so far —
  // and, once the guard stage arrives, the guard's caller gains the real `if (!guard(...))` body
  // instead of gaining a new declaration.
  const declaredNodesFor = (uptoIndex: number): CodeSymbol[] => (guard && uptoIndex === steps.length ? declarableChain.slice(0, declarableChain.length - 1) : declarableChain.slice(0, uptoIndex + 1));
  const bodyForPosition = (p: number, declared: CodeSymbol[], isGuardFinal: boolean): string => {
    if (p < declared.length - 1) return `return await ${callExpr(declared[p + 1]!)};`;
    if (isGuardFinal) return `if (!${guard!.edge.to.symbol}(${args})) return "denied";\n    return "allowed";`;
    return `return "reached:${displayLabel(declared[p]!)}";`;
  };
  const codeFor = (uptoIndex: number): string => {
    const isGuardFinal = Boolean(guard) && uptoIndex === steps.length;
    const declared = declaredNodesFor(uptoIndex);
    const importLine = isGuardFinal ? `import { ${guard!.edge.to.symbol} } from "./guard.ts";\n\n` : "";
    return importLine + declared.map((node, p) => declSnippet(node, bodyForPosition(p, declared, isGuardFinal))).join("\n\n") + "\n";
  };

  let guardSource = "";
  const support: CodeFile[] = [];
  if (guard) {
    guardSource = snippetOf(index, guard.guardDecl).replace(/^(async\s+)?function\s+/, (match) => `export ${match}`);
    support.push({ path: "guard.ts", content: `${guardSource}\n` });
  }

  const callArgsForTest = guard ? `new Request("http://x"), undefined` : `"x"`;
  const testFor = (uptoIndex: number): string => {
    if (guard && uptoIndex === steps.length) {
      return [
        `import { test, expect } from "ownr:test";`,
        `import { ${entrySymbol} } from "./chain.ts";`,
        `test("permite sem chave configurada", async () => { expect(await ${entrySymbol}(new Request("http://x"), undefined)).toBe("allowed"); });`,
        `test("nega chave incorreta", async () => { const req = new Request("http://x", { headers: { "x-api-key": "wrong" } }); expect(await ${entrySymbol}(req, "secret")).toBe("denied"); });`,
        `test("permite chave correta", async () => { const req = new Request("http://x", { headers: { "x-api-key": "secret" } }); expect(await ${entrySymbol}(req, "secret")).toBe("allowed"); });`,
      ].join("\n");
    }
    return [
      `import { test, expect } from "ownr:test";`,
      `import { ${entrySymbol} } from "./chain.ts";`,
      `test("alcança ${displayLabel(declarableChain[uptoIndex]!)}", async () => { expect(await ${entrySymbol}(${callArgsForTest})).toBe("reached:${displayLabel(declarableChain[uptoIndex]!)}"); });`,
    ].join("\n");
  };

  const stages: Stage[] = [];
  let previousLimitation = `${entrySymbol} ainda não encaminha a requisição para ninguém.`;

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const uptoIndex = stepIndex + 1;
    const step = steps[stepIndex]!;
    const directEdge = step.edges[0]!;
    const isFinal = stepIndex === steps.length - 1;
    const isGuardHop = Boolean(guard) && isFinal;
    const targetLabel = displayLabel(step.to);
    const callerSymbol = directEdge.from.symbol;
    const solutionContent = codeFor(uptoIndex);
    const starterContent = uptoIndex === 1 ? "" : codeFor(uptoIndex - 1);

    // When a step passed through an interface, the narrative teaches that distinction explicitly:
    // the caller depends on a contract, resolved (by discovery) to the one real class in the
    // pinned source that implements it — never guessed, and never silently merged away.
    const viaInterface = step.edges.length > 1 ? step.edges[0]!.to : null;
    const contractNote = viaInterface
      ? ` Essa chamada depende de injeção de dependência: ${callerSymbol} conhece apenas o contrato ${viaInterface.container}; ${targetLabel} é a única implementação real encontrada no SHA fixado.`
      : "";

    const narrative = stageNarrative({
      previous: uptoIndex === 1 ? `A requisição chega em ${entrySymbol}, o ponto de entrada HTTP deste servidor.` : `Na etapa anterior, a cadeia chegou a ${displayLabel(declarableChain[uptoIndex - 1]!)}.`,
      need: isGuardHop ? `No código real, ${callerSymbol} só continua se ${targetLabel} autorizar a requisição.` : `No código real, ${callerSymbol} chama ${targetLabel} para continuar o fluxo.${contractNote}`,
      limitation: previousLimitation,
      task: isGuardHop ? `chame ${targetLabel} dentro de ${callerSymbol} e negue a continuação quando ele devolver falso.` : `crie ${targetLabel} e faça ${callerSymbol} chamá-lo.`,
      outcome: isGuardHop ? `a requisição só é permitida quando ${targetLabel} confirma o acesso.` : `a cadeia chega a ${targetLabel}, o componente real relevante para o objetivo.`,
      code: isGuardHop ? `if (!${targetLabel}(${args})) return "denied"; do contrário, devolve "allowed".` : `${callerSymbol} chama ${callExpr(step.to)} e devolve o resultado.`,
      detail: viaInterface
        ? `No SHA fixado, ${directEdge.from.symbol} chama ${displayLabel(directEdge.to)} em ${directEdge.from.path}:${directEdge.line}: \`${directEdge.snippet}\`. \`${step.edges.at(-1)!.snippet}\` é a única classe do SHA fixado que implementa ${viaInterface.container}.`
        : `No SHA fixado, ${directEdge.from.symbol} chama ${targetLabel} em ${directEdge.from.path}:${directEdge.line}: \`${directEdge.snippet}\`.`,
    });
    const limitation = isFinal
      ? "Agora reconstrua o encadeamento inteiro sem o ponto de partida."
      : `${targetLabel} ainda não encaminha a requisição para o próximo passo real.`;

    const targetRefNote = isGuardHop
      ? `O Replay reexporta ${targetLabel} sem alterar a lógica: a comparação é idêntica à do código real.`
      : `O Replay reduz ${targetLabel} a um marcador que confirma que esta chamada real foi alcançada; o comportamento completo está no trecho de código real citado aqui, não executado nesta etapa.`;
    const originalRefs: OriginalCodeReference[] = [];
    if (isGuardHop) originalRefs.push(reference(index, journey, declarations[uptoIndex - 1]!, `O Replay reduz ${callerSymbol} à decisão de acesso; o código real também roteia as demais operações da API.`));
    if (viaInterface) {
      const interfaceDecl = index.declarations.find((d) => d.path === viaInterface.path && d.symbol === viaInterface.symbol && d.container === viaInterface.container);
      if (interfaceDecl) originalRefs.push(reference(index, journey, interfaceDecl, `${callerSymbol} depende apenas deste contrato, não da implementação concreta.`));
    }
    originalRefs.push(reference(index, journey, declarations[uptoIndex]!, targetRefNote));

    const stage = Stage.parse({
      id: `${journey.id}.flow-${String(uptoIndex).padStart(2, "0")}`,
      order: uptoIndex,
      moduleId: plan.moduleId,
      kind: "micro",
      title: isGuardHop ? `Verificar ${targetLabel} antes de continuar` : `Encaminhar para ${targetLabel}`,
      goal: isGuardHop
        ? "Aprender que uma função de guarda decide, com um booleano, se a ação protegida pode continuar."
        : `Aprender que ${callerSymbol} encaminha a chamada para ${targetLabel}, o componente real ligado ao objetivo.`,
      context: narrative.context,
      problem: narrative.problem,
      examples: [],
      requirements: [],
      estimatedMinutes: isFinal ? 3 : 2,
      introduces: [],
      prerequisites: [],
      architecture: flowArchitecture(declarableChain, uptoIndex),
      referenceCode: [{ path: "chain.ts", content: solutionContent }],
      lineNotes: [{ match: isGuardHop ? `if (!${targetLabel}(${args})) return "denied";` : `return await ${callExpr(step.to)};`, note: narrative.quick }],
      explanation: [{ id: `flow-${uptoIndex}`, title: targetLabel, quick: narrative.quick, normal: narrative.normal }],
      originalCodeRefs: originalRefs,
      exercise: {
        instructions: isGuardHop
          ? `Importe ${targetLabel} de guard.ts. Dentro de ${callerSymbol}, devolva "denied" quando ${targetLabel}(${args}) for falso; senão devolva "allowed".`
          : `Crie ${targetLabel} devolvendo "reached:${targetLabel}", e faça ${callerSymbol} chamá-lo e devolver o resultado.`,
        starterFiles: [{ path: "chain.ts", content: starterContent }],
        solutionFiles: [{ path: "chain.ts", content: solutionContent }],
        supportFiles: isFinal ? support : [],
        expose: [],
        testFile: { path: "tests.ts", content: testFor(uptoIndex) },
      },
      toolbox: isGuardHop ? [{ id: "guard", name: targetLabel, summary: "Função real do repositório usada nesta etapa.", example: guardSource }] : [],
      tutorContext: { relevantFiles: ["chain.ts", ...(isGuardHop ? ["guard.ts"] : []), declarations[uptoIndex]!.path], concepts: [], previousStages: stages.map((s) => s.id) },
      completionCriteria: [{ kind: "tests_pass" }],
      limitation,
      summary: { added: [targetLabel], why: narrative.problem, flow: declarableChain.slice(0, uptoIndex + 1).map(displayLabel) },
    });
    stages.push(stage);
    previousLimitation = limitation;
  }

  const stepsNarrative = steps
    .map((step) => {
      const direct = step.edges[0]!;
      const base = `${direct.from.symbol} chama ${displayLabel(direct.to)} em ${direct.from.path}:${direct.line} (\`${direct.snippet}\`)`;
      if (step.edges.length === 1) return base;
      const impl = step.edges.at(-1)!;
      return `${base}, resolvida por injeção de dependência à única implementação real: ${displayLabel(impl.to)} (\`${impl.snippet}\`)`;
    })
    .join("; depois, ");
  const tail = guard
    ? ` ${displayLabel(chain.at(-1)!)} compara o cabeçalho x-api-key com a chave configurada e só nega quando uma chave está configurada e não bate; sem chave configurada, tudo é permitido.`
    : ` O comportamento completo de ${displayLabel(declarableChain.at(-1)!)} está no trecho de código real referenciado na etapa anterior (não executado aqui: depende de infraestrutura que este sandbox não provê).`;

  const finalStage = stages.at(-1)!;
  const checkpoint = Stage.parse({
    ...finalStage,
    id: `${journey.id}.flow-99`,
    order: stages.length + 1,
    kind: "checkpoint",
    title: "Checkpoint: reconstrua a cadeia descoberta",
    goal: `Reconstruir ${declarableChain.map(displayLabel).join(" -> ")} do editor vazio.`,
    context: "Todas as peças foram introduzidas uma a uma.",
    problem: `Agora reconstrua a cadeia inteira: ${declarableChain.map(displayLabel).join(" -> ")}.`,
    requirements: steps.map((step) => `${step.edges[0]!.from.symbol} deve chamar ${displayLabel(step.to)}.`),
    exercise: { ...finalStage.exercise!, starterFiles: [{ path: "chain.ts", content: "" }] },
    tutorContext: { ...finalStage.tutorContext, previousStages: stages.map((s) => s.id) },
    checkpoint: {
      question: `Como a chamada chega de ${entrySymbol} até ${displayLabel(chain.at(-1)!)}, e o que o código real faz nesse ponto?`,
      answer: `No SHA fixado: ${stepsNarrative}.${tail}`,
    },
    limitation: undefined,
    summary: { added: declarableChain.map(displayLabel), why: "Conectar o ponto de entrada HTTP ao componente real relevante para o objetivo.", flow: declarableChain.map(displayLabel) },
  });

  return [...stages, checkpoint];
}
