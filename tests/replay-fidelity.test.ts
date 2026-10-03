import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { golden, resilientSource } from "./helpers.ts";
import { indexRepository, originalDir, type RepositoryIndex } from "../src/services/code-map.ts";
import type { Journey } from "../src/domain/journey.ts";
import type { FlowIntent } from "../src/services/flow-discovery.ts";
import { isInterfaceDeclaration } from "../src/services/flow-discovery.ts";
import type { Stage } from "../src/domain/stage.ts";
import { locateTsc, TypeChecker } from "../src/sandbox/typecheck.ts";
import { ModuleGenerationService, StageGenerator, StagePlanner, StageValidator } from "../src/services/stage-generation.ts";

/**
 * A learner must never leave a stage with a false structural idea about how the real components
 * relate. The Replay may simplify data and omit bodies; it may not turn an interface into a class,
 * construct what the real code receives, or call around a dependency instead of through it.
 */
const checker = new TypeChecker(await locateTsc());
const rta = resilientSource();
const opsIndex = indexRepository(originalDir(join(import.meta.dir, "../data/golden/ops-triage-ai")));
const service = () => new ModuleGenerationService(mkdtempSync(join(tmpdir(), "replay-fidelity-")), new StagePlanner(), new StageGenerator(), new StageValidator(checker));
const generate = (base: Journey, index: RepositoryIndex, goal: string, intent: FlowIntent) => service().generateRequestJourney(base, goal, index, intent);

const PERSISTENCE = "Quero entender como uma transação é persistida no banco de dados.";
const OPS_PERSISTENCE = "Quero entender como uma decisão de triagem é persistida no banco de dados.";
const OPS_AUTH = "Quero entender como funciona a autenticação das requisições neste projeto.";
const codeOf = (stage: Stage): string => stage.exercise?.solutionFiles[0]?.content ?? "";
const realDeclaration = (index: RepositoryIndex, name: string) => index.declarations.find((d) => d.container === null && d.symbol === name);
const realText = (index: RepositoryIndex, name: string): string => {
  const d = realDeclaration(index, name);
  return d ? (index.files.get(d.path) ?? "").split("\n").slice(d.startLine - 1, d.endLine).join("\n") : "";
};

/** Every way a chain.ts can misrepresent the real structure, checked against the real source. */
function structuralProblems(index: RepositoryIndex, code: string): string[] {
  const problems: string[] = [];
  const declaredInterfaces = new Set([...code.matchAll(/export interface (\w+)/g)].map((m) => m[1]!));
  for (const [, name] of code.matchAll(/export class (\w+)/g) as Iterable<[string, string]>) {
    const real = realDeclaration(index, name);
    if (real && isInterfaceDeclaration(index, real.path, name)) problems.push(`${name} é interface no código real, mas classe no Replay`);
  }
  for (const [, name] of code.matchAll(/export interface (\w+)/g) as Iterable<[string, string]>) {
    const real = realDeclaration(index, name);
    if (real && !isInterfaceDeclaration(index, real.path, name)) problems.push(`${name} é ${/^(?:export\s+)?class\b/.test(realText(index, name)) ? "classe" : "outro tipo"} no código real, mas interface no Replay`);
  }
  for (const [, name] of code.matchAll(/export type (\w+) =/g) as Iterable<[string, string]>) {
    const real = realText(index, name);
    if (real && !/^(?:export\s+)?type\b/.test(real)) problems.push(`${name} não é um type alias no código real`);
  }
  for (const [, name] of code.matchAll(/implements (\w+)/g) as Iterable<[string, string]>) if (!declaredInterfaces.has(name)) problems.push(`implements ${name}, que o Replay não declara como interface`);
  // A dependency the real class receives through its constructor is received with the SAME declared type.
  for (const [, container] of code.matchAll(/export class (\w+)/g) as Iterable<[string, string]>) {
    const real = realText(index, container);
    for (const [, field, type] of code.matchAll(/private readonly (\w+): ([^,)]+)[,)]/g) as Iterable<[string, string, string]>) {
      if (real && code.includes(`export class ${container}`) && !real.includes(`${field}: ${type}`) && new RegExp(`class ${container}[^{]*\\{[\\s\\S]*?private readonly ${field}`).test(code)) problems.push(`${container}.${field}: ${type} não é como o código real o recebe`);
    }
  }
  // Members of a reduced type keep the real declaration (\`name?: type\`, \`Pick<X, "m">\`).
  for (const [, name, body] of code.matchAll(/export (?:interface|type) (\w+)(?: =)? \{\n([\s\S]*?)\n\}/g) as Iterable<[string, string, string]>) {
    const real = realText(index, name);
    if (!real) continue;
    for (const member of body.split("\n").map((line) => line.trim().replace(/;$/, "")).filter((line) => /^\w+\??:/.test(line))) if (!real.replace(/\s+/g, " ").includes(member.replace(/\s+/g, " "))) problems.push(`${name}.${member} não existe assim no código real`);
  }
  if (/reached:/.test(code)) problems.push("marcador reached: no lugar de uma relação");
  if (/\bnew\s/.test(code)) problems.push("o Replay constrói algo que o código real recebe (new)");
  return problems;
}

const CASES: { name: string; base: () => Journey; index: () => RepositoryIndex; intent: FlowIntent; goal: string }[] = [
  { name: "resilient · persistência · other", base: () => rta.base, index: () => rta.index, intent: "other", goal: PERSISTENCE },
  { name: "resilient · persistência · trace_request", base: () => rta.base, index: () => rta.index, intent: "trace_request", goal: PERSISTENCE },
  { name: "resilient · autenticação · trace_request", base: () => rta.base, index: () => rta.index, intent: "trace_request", goal: "Quero entender como funciona a autenticação das requisições" },
  { name: "resilient · pagamento · other", base: () => rta.base, index: () => rta.index, intent: "other", goal: "Quero entender como o pagamento é processado pelo provedor" },
  { name: "resilient · limite · trace_request", base: () => rta.base, index: () => rta.index, intent: "trace_request", goal: "Quero entender como funciona o limite de requisições" },
  { name: "resilient · criação · other (funções)", base: () => rta.base, index: () => rta.index, intent: "other", goal: "Quero entender o fluxo de criação de uma transação" },
  { name: "resilient · disjuntor · other (métodos irmãos)", base: () => rta.base, index: () => rta.index, intent: "other", goal: "Quero entender como funciona o disjuntor de circuito" },
  { name: "ops-triage-ai · persistência", base: () => golden(), index: () => opsIndex, intent: "trace_request", goal: OPS_PERSISTENCE },
  { name: "ops-triage-ai · autenticação", base: () => golden(), index: () => opsIndex, intent: "trace_request", goal: OPS_AUTH },
];

for (const item of CASES) {
  test(`fidelidade estrutural em todos os estágios: ${item.name}`, async () => {
    const route = await generate(item.base(), item.index(), item.goal, item.intent);
    const index = item.index();
    for (const stage of route.stages) expect(structuralProblems(index, codeOf(stage)), `${stage.id}`).toEqual([]);
    // Cumulative workspace and checkpoint: each stage grows the previous one; the checkpoint rebuilds the last.
    const micro = route.stages.filter((s) => s.kind === "micro");
    micro.forEach((stage, i) => expect(stage.exercise?.starterFiles[0]?.content ?? "").toBe(i === 0 ? "" : codeOf(micro[i - 1]!)));
    expect(codeOf(route.stages.at(-1)!)).toBe(codeOf(micro.at(-1)!));
    // Real code references stay exact slices of the pinned source.
    for (const ref of route.stages.flatMap((s) => s.originalCodeRefs)) expect(index.files.get(ref.path)?.split("\n").slice(ref.startLine - 1, ref.endLine).join("\n")).toBe(ref.snippet);
  });
}

test("o exemplo da persistência (other): interface, dependência injetada e chamada através dela", async () => {
  const route = await generate(rta.base, rta.index, PERSISTENCE, "other");
  expect(route.stages.map((s) => s.kind)).toEqual(["micro", "checkpoint"]);
  expect(codeOf(route.stages[0]!)).toBe(
    [
      "export interface TransactionRepository {",
      "  completeIdempotencyOperation(): Promise<string>;",
      "}",
      "",
      "export class CreateTransaction {",
      "  constructor(private readonly transactionRepository: TransactionRepository) {}",
      "",
      "  async execute(): Promise<string> {",
      "    return await this.transactionRepository.completeIdempotencyOperation();",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  // The test wires the contract the way a composition root would: it INJECTS a stand-in, it does not instantiate an interface.
  const test = route.stages[0]!.exercise!.testFile.content;
  expect(test).toContain("new CreateTransaction({ completeIdempotencyOperation:");
  expect(test).not.toContain("new TransactionRepository");
  // The narrative and the code now say the same thing about the contract.
  expect(route.stages[0]?.context).toContain("uma interface, nunca de uma classe concreta");
  expect(route.stages[0]?.explanation[0]?.normal).toContain("2 implementações (PostgresTransactionRepository, InMemoryTransactionRepository)");
});

test("resilient trace: fábrica de handler, dependências como parâmetro e o tipo real Pick<>", async () => {
  const route = await generate(rta.base, rta.index, PERSISTENCE, "trace_request");
  const code = codeOf(route.stages[2]!);
  expect(code).toContain("export type HttpHandler = (request: Request) => Promise<string>;");
  expect(code).toContain("export function createHttpHandler(dependencies: ServerDependencies): HttpHandler {");
  expect(code).toContain('createTransaction: Pick<CreateTransaction, "execute">;');
  expect(code).toContain("return await dependencies.createTransaction.execute();");
  expect(code).toContain("constructor(private readonly transactionRepository: TransactionRepository) {}");
  expect(code).not.toContain("class TransactionRepository");
  // routeRequest receives its dependency: nothing inside it constructs one.
  const routeRequest = /export async function routeRequest[\s\S]*?\n\}/.exec(code)?.[0] ?? "";
  expect(routeRequest).not.toContain("new ");
});

test("ops-triage-ai persistência: contrato, implementação e injeção em estágios separados, sem classe no lugar da interface", async () => {
  const route = await generate(golden(), opsIndex, OPS_PERSISTENCE, "trace_request");
  expect(route.stages.map((s) => s.title)).toEqual([
    "Encaminhar para routeRequest",
    "Depender do contrato TriageService",
    "Implementar TriageService em PersistedTriageService",
    "Depender do contrato TriageRunRepository",
    "Implementar TriageRunRepository em PrismaTriageRunRepository",
    "Encaminhar para createDecision",
    "Checkpoint: reconstrua a cadeia descoberta",
  ]);
  const code = codeOf(route.stages.at(-1)!);
  for (const line of [
    "export interface ServerDependencies {",
    "  triageService: TriageService;",
    "export interface TriageRunRepository {",
    "export class PersistedTriageService implements TriageService {",
    "  constructor(private readonly triageRunRepository: TriageRunRepository) {}",
    "    return await this.triageRunRepository.complete();",
    "export class PrismaTriageRunRepository implements TriageRunRepository {",
    "  return await dependencies.triageService.execute();",
  ]) expect(code).toContain(line);
  // The contract whose file is not in the indexed source is declared, and the narrative says so.
  expect(route.stages[1]?.context).toContain("não está entre os fontes indexados");
  expect(route.stages[1]?.originalCodeRefs.map((r) => r.symbol)).not.toContain("TriageService");
});

test("ops-triage-ai autenticação: a chave vem de dependencies.apiKey e a guarda é o código real", async () => {
  const route = await generate(golden(), opsIndex, OPS_AUTH, "trace_request");
  const code = codeOf(route.stages.at(-1)!);
  expect(code).toContain("apiKey?: string;");
  expect(code).toContain("if (!authorized(req, dependencies.apiKey)) return \"denied\";");
  expect(code).not.toContain("apiKey: string | undefined");
  const guard = route.stages.at(-1)!.exercise!.supportFiles.find((f) => f.path === "guard.ts")!.content;
  expect(guard).toContain('req.headers.get("x-api-key")');
});

test("relação que o Replay não consegue reproduzir com fidelidade falha alto, em vez de virar outra arquitetura", async () => {
  // The chain reaches RetryPolicy by `new RetryPolicy(...)`: a class instantiation, not a function call.
  await expect(generate(rta.base, rta.index, "Quero entender como funcionam as tentativas de retry", "other")).rejects.toThrow("não reproduzível com fidelidade");
});
