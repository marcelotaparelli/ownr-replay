import type { Journey } from "../domain/journey.ts";
import { Stage, type CodeFile, type OriginalCodeReference } from "../domain/stage.ts";
import type { RepositoryIndex } from "./code-map.ts";
import { stageNarrative } from "./stage-narrative.ts";

type Link = { from: string; to: string; relation: string; path: string; proof: RegExp };
type TraceStep = { symbol: string; path: string; title: string; need: string; call: string; expected: string; limitation: string; links: Link[] };
export type RequestTracePlan = { kind: "request-trace"; goal: string; moduleId: string; steps: TraceStep[] };

/** Cheap, reusable pre-check: does this free text plausibly describe the ticket flow? Lets a caller
 *  decide whether to attempt the (expensive) generator before planRequestTrace's own deeper checks run. */
// Deliberately narrow: "ticket" (or the literal route) is what this hand-authored trace is
// actually about. It used to also trigger on the bare word "triage"/"triagem", which collides
// with any goal about the triage DOMAIN in general (e.g. "how is a triage decision persisted?") —
// those are exactly the goals the generic discovery path (flow-discovery.ts) should get instead.
export const looksLikeTicketFlowGoal = (goal: string): boolean => /ticket|\/tickets\/triage/i.test(goal);

// These are candidate links, not claims: the planner checks every link against the pinned source.
const candidates: TraceStep[] = [
  { symbol: "parseTicketInput", path: "src/http/triage-request.ts", title: "Validar a entrada", need: "O corpo HTTP é desconhecido até passar pela validação.", call: "const ticket = parseTicketInput(input);", expected: "ticket", limitation: "Um ticket válido ainda não iniciou a triagem.", links: [{ from: "handleRequest", to: "parseTicketInput", relation: "validates", path: "src/server.ts", proof: /parseTicketInput\(payload\.value\)/ }] },
  { symbol: "PersistedTriageService", path: "src/application/persisted-triage-service.ts", title: "Entrar no serviço", need: "A rota entrega o ticket validado ao serviço de aplicação.", call: "const service = await enterService(ticket);", expected: "service", limitation: "O serviço ainda precisa registrar o início da execução.", links: [{ from: "handleRequest", to: "PersistedTriageService", relation: "routes_to", path: "src/server.ts", proof: /triageService\.execute\(parsed\.data\)/ }, { from: "handleRequest", to: "PersistedTriageService", relation: "depends_on", path: "src/index.ts", proof: /new PersistedTriageService\(/ }] },
  { symbol: "PrismaTriageRunRepository", path: "src/infrastructure/persistence/prisma-triage-repositories.ts", title: "Registrar o início", need: "O serviço grava ticket e execução antes de classificar.", call: "const started = await startRun(service);", expected: "started", limitation: "A execução existe, mas ainda não há classificação.", links: [{ from: "PersistedTriageService", to: "PrismaTriageRunRepository", relation: "persists", path: "src/application/persisted-triage-service.ts", proof: /triageRunRepository\.start\(/ }, { from: "PersistedTriageService", to: "PrismaTriageRunRepository", relation: "depends_on", path: "src/index.ts", proof: /new PrismaTriageRunRepository\(prisma\)/ }] },
  { symbol: "TriageTicket", path: "src/application/triage-ticket.ts", title: "Classificar o ticket", need: "O caso de uso escolhe o classificador conforme o modo configurado.", call: "const classified = await classifyTicket(started);", expected: "classified", limitation: "O resultado do classificador ainda não é uma decisão de triagem.", links: [{ from: "PersistedTriageService", to: "TriageTicket", relation: "calls", path: "src/application/persisted-triage-service.ts", proof: /triageTicket\.execute\(input\)/ }] },
  { symbol: "HybridPolicy", path: "src/application/policies/hybrid-policy.ts", title: "Formar a decisão", need: "A política acrescenta origem e motivos de revisão ao resultado.", call: "const decided = decide(classified);", expected: "decided", limitation: "A decisão ainda não foi gravada como conclusão da execução.", links: [{ from: "TriageTicket", to: "HybridPolicy", relation: "calls", path: "src/application/triage-ticket.ts", proof: /policy\.decide(?:Single)?\(/ }] },
  { symbol: "PrismaTriageRunRepository", path: "src/infrastructure/persistence/prisma-triage-repositories.ts", title: "Persistir a decisão", need: "O serviço conclui a execução e grava a decisão em transação.", call: "const saved = await completeRun(decided);", expected: "saved", limitation: "A decisão gravada ainda precisa voltar ao cliente HTTP.", links: [{ from: "PersistedTriageService", to: "PrismaTriageRunRepository", relation: "persists", path: "src/application/persisted-triage-service.ts", proof: /triageRunRepository\.complete\(/ }, { from: "PrismaTriageRunRepository", to: "PrismaTriageRunRepository", relation: "writes", path: "src/infrastructure/persistence/prisma-triage-repositories.ts", proof: /await createDecision\(tx, input\)/ }] },
  { symbol: "handleRequest", path: "src/server.ts", title: "Responder pela API", need: "A rota devolve o identificador e a decisão persistida com status 201.", call: "const response = respond(saved);", expected: "response", limitation: "Agora reconstruímos a ligação completa sem o código inicial.", links: [{ from: "PersistedTriageService", to: "handleRequest", relation: "flows_to", path: "src/server.ts", proof: /return json\(201, \{ id: execution\.decisionId, \.\.\.execution\.decision \}/ }] },
];

const support: CodeFile = { path: "flow.ts", content: `export type Ticket = { title: string; description: string };
export type Flow = { ticket: Ticket; serviceEntered?: boolean; runId?: string; result?: string; decision?: string; decisionId?: string };
export const calls: string[] = [];
export function parseTicketInput(input: Ticket): Flow { calls.push("parseTicketInput"); if (!input.title.trim() || !input.description.trim()) throw new Error("invalid_request"); return { ticket: input }; }
export async function enterService(flow: Flow): Promise<Flow> { calls.push("enterService"); return { ...flow, serviceEntered: true }; }
export async function startRun(flow: Flow): Promise<Flow> { calls.push("startRun"); return { ...flow, runId: "run-1" }; }
export async function classifyTicket(flow: Flow): Promise<Flow> { calls.push("classifyTicket"); return { ...flow, result: flow.ticket.title.includes("down") ? "INCIDENT" : "OTHER" }; }
export function decide(flow: Flow): Flow { calls.push("decide"); return { ...flow, decision: flow.result }; }
export async function completeRun(flow: Flow): Promise<Flow> { calls.push("completeRun"); return { ...flow, decisionId: "decision-1" }; }
export function respond(flow: Flow) { calls.push("respond"); return { status: 201, id: flow.decisionId, decision: flow.decision }; }
` };
const imports = `import { parseTicketInput, enterService, startRun, classifyTicket, decide, completeRun, respond, type Ticket } from "./flow.ts";`;
const code = (steps: TraceStep[]): string => `${imports}\nexport async function trace(input: Ticket) {\n${steps.map((step) => `  ${step.call}`).join("\n")}\n  return ${steps.at(-1)?.expected ?? "input"};\n}\n`;
function methodFor(step: TraceStep): string {
  const method = /=\s*(?:await\s+)?(\w+)\(/.exec(step.call)?.[1];
  if (!method) throw new Error(`Chamada inválida: ${step.call}`);
  return method;
}
function toolboxExample(step: TraceStep): string {
  const method = methodFor(step);
  const lines = support.content.split("\n");
  const definition = lines.find((line) => line.includes(`function ${method}(`));
  if (!definition) throw new Error(`Função de apoio ausente: ${step.call}`);
  const input = method === "parseTicketInput" ? `{ title: "site down", description: "indisponível" }` : `{ ticket: { title: "site down", description: "indisponível" } }`;
  return `${lines[0]}\n${lines[1]}\n${lines[2]}\n${definition}\nvoid ${method}(${input});`;
}

export function planRequestTrace(goal: string, journey: Journey, index: RepositoryIndex): RequestTracePlan {
  if (journey.repo.name !== "ops-triage-ai" || journey.repo.owner !== "marcelotaparelli") throw new Error("Fluxo HTTP ainda não suportado para este repositório.");
  if (!looksLikeTicketFlowGoal(goal)) throw new Error("O objetivo não identifica o fluxo de tickets disponível.");
  const explicitRoute = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i.exec(goal);
  if (explicitRoute && (explicitRoute[1]?.toUpperCase() !== "POST" || explicitRoute[2]?.replace(/[.,;!?]+$/, "") !== "/tickets/triage")) throw new Error("Esta rota ainda não tem um percurso validado.");
  const server = index.files.get("src/server.ts") ?? "";
  if (!/req\.method === "POST" && url\.pathname === "\/tickets\/triage"/.test(server)) throw new Error("Rota de triagem ausente no SHA fixado.");
  for (const step of candidates) {
    if (!index.declarations.some((d) => d.path === step.path && d.symbol === step.symbol && d.container === null)) throw new Error(`Símbolo ${step.symbol} ausente no SHA fixado.`);
    for (const link of step.links) if (!link.proof.test(index.files.get(link.path) ?? "")) throw new Error(`Conexão ${link.from} → ${link.to} não comprovada em ${link.path}.`);
  }
  return { kind: "request-trace", goal, moduleId: "flow", steps: candidates };
}

function reference(journey: Journey, index: RepositoryIndex, step: TraceStep): OriginalCodeReference {
  const declaration = index.declarations.find((d) => d.path === step.path && d.symbol === step.symbol && d.container === null)!;
  const snippet = (index.files.get(step.path) ?? "").split("\n").slice(declaration.startLine - 1, declaration.endLine).join("\n");
  return { path: step.path, symbol: step.symbol, startLine: declaration.startLine, endLine: declaration.endLine, replayFile: "trace.ts", note: "O Replay reduz este componente a uma chamada observável; veja as regras e efeitos reais no trecho do repositório.", snippet, url: `${journey.repo.url}/blob/${journey.repo.sha}/${step.path}#L${declaration.startLine}-L${declaration.endLine}` };
}

export function generateRequestTrace(plan: RequestTracePlan, journey: Journey, index: RepositoryIndex): Stage[] {
  const stages: Stage[] = [];
  for (const [i, step] of plan.steps.entries()) {
    const previous = plan.steps[i - 1];
    const content = code(plan.steps.slice(0, i + 1));
    const before = i ? code(plan.steps.slice(0, i)) : "";
    const nodes = plan.steps.slice(0, i + 1).map((item, n) => ({ id: `flow-${n}`, label: item.symbol, kind: item.symbol === "parseTicketInput" || item.symbol === "handleRequest" ? "function" as const : "class" as const, col: n % 3, row: Math.floor(n / 3) }));
    const edges = nodes.slice(1).map((node, n) => ({ from: nodes[n]!.id, to: node.id, rel: "flows_to" as const }));
    const narrative = stageNarrative({ previous: previous ? `Na etapa anterior, ${previous.need}` : "A requisição entra por POST /tickets/triage.", need: step.need, limitation: previous?.limitation ?? "O corpo recebido ainda não é um ticket confiável.", task: `ligue ${step.symbol} ao fluxo.`, outcome: `o percurso chega a ${step.title.toLowerCase()}.`, code: `A chamada ${step.call} passa o valor adiante; a versão real está em ${step.path}.`, detail: `No SHA fixado, ${step.links.map((link) => `${link.from} ${link.relation} ${link.to} em ${link.path}`).join("; ")}.` });
    const last = i === plan.steps.length - 1;
    const test = `import { test, expect } from "ownr:test";\nimport { trace } from "./trace.ts";\nimport { calls } from "./flow.ts";\ntest("fluxo até ${step.symbol}", async () => { calls.length = 0; const value = await trace({ title: "site down", description: "indisponível" }); expect(value).toEqual(${JSON.stringify(last ? { status: 201, id: "decision-1", decision: "INCIDENT" } : i === 0 ? { ticket: { title: "site down", description: "indisponível" } } : { ticket: { title: "site down", description: "indisponível" }, serviceEntered: true, ...(i >= 2 ? { runId: "run-1" } : {}), ...(i >= 3 ? { result: "INCIDENT" } : {}), ...(i >= 4 ? { decision: "INCIDENT" } : {}), ...(i >= 5 ? { decisionId: "decision-1" } : {}) })}); expect(calls).toEqual(${JSON.stringify(plan.steps.slice(0, i + 1).map(methodFor))}); });`;
    stages.push(Stage.parse({ id: `${journey.id}.flow-${String(i + 1).padStart(2, "0")}`, order: i + 1, moduleId: "flow", kind: "micro", title: step.title, goal: step.need, context: narrative.context, problem: narrative.problem, examples: [], requirements: [], estimatedMinutes: 2, introduces: [], prerequisites: [], architecture: { nodes, edges }, referenceCode: [{ path: "trace.ts", content }], lineNotes: [{ match: step.call, note: narrative.quick }], explanation: [{ id: `flow-${i}`, title: step.title, quick: narrative.quick, normal: narrative.normal }], originalCodeRefs: [reference(journey, index, step)], exercise: { instructions: `Faça o Replay avançar até ${step.title.toLowerCase()} usando o componente disponível.`, starterFiles: [{ path: "trace.ts", content: before }], solutionFiles: [{ path: "trace.ts", content }], supportFiles: [support], expose: [], testFile: { path: "tests.ts", content: test } }, toolbox: [{ id: `flow-${i}`, name: `Replay: ${step.symbol}`, summary: step.need, example: toolboxExample(step) }], tutorContext: { relevantFiles: ["trace.ts", step.path], concepts: [], previousStages: stages.map((stage) => stage.id) }, completionCriteria: [{ kind: "tests_pass" }], limitation: step.limitation, summary: { added: [step.title], why: step.need, flow: nodes.map((node) => node.label) } }));
  }
  const final = stages.at(-1)!;
  stages.push(Stage.parse({ ...final, id: `${journey.id}.flow-99`, order: stages.length + 1, kind: "checkpoint", title: "Checkpoint: conecte o percurso completo", goal: "Reconstruir da entrada HTTP à resposta após persistência.", context: "Todas as chamadas foram introduzidas uma a uma.", problem: "Agora reconstrua a sequência inteira e explique por que a decisão só volta após a conclusão persistida.", requirements: ["Valide o ticket antes de iniciar a execução.", "Classifique e forme a decisão antes de gravá-la.", "Responda com o identificador da decisão persistida."], exercise: { ...final.exercise!, starterFiles: [{ path: "trace.ts", content: "" }] }, tutorContext: { ...final.tutorContext, previousStages: stages.map((stage) => stage.id) }, checkpoint: { question: "Como a entrada HTTP chega à decisão persistida, e quando a API pode responder 201?", answer: "A rota valida o ticket e chama PersistedTriageService.execute. O serviço registra o início, chama TriageTicket, que classifica e usa HybridPolicy para formar a decisão. O serviço conclui a execução via PrismaTriageRunRepository e só então devolve decisionId e decisão à rota, que responde 201." }, limitation: undefined }));
  return stages;
}
