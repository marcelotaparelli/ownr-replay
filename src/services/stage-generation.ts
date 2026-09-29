import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../domain/journey.ts";
import { Stage, type CodeFile, type OriginalCodeReference } from "../domain/stage.ts";
import { noveltyLines } from "../domain/line-diff.ts";
import { completeExercise, prepareExercise } from "../sandbox/modules.ts";
import { executeModules } from "../sandbox/execute.ts";
import type { TypeChecker } from "../sandbox/typecheck.ts";
import { resolveNode, type RepositoryIndex } from "./code-map.ts";
import { validateJourney } from "./curriculum.ts";
import { shownSnippets, snippetProblems } from "./curriculum-check.ts";
import { stageNarrative } from "./stage-narrative.ts";
import { generateStructuredDecision, planStructuredDecision, type StructuredDecisionPlan } from "./structured-decision-generation.ts";
import { generateRemoteClassifier, planRemoteClassifier, type RemoteClassifierPlan } from "./remote-classifier-generation.ts";

/** One narrow provider contract. Other generators can replace this without entering the API or core. */
export interface StageGenerationProvider {
  generate(plan: StagePlan, journey: Journey, index: RepositoryIndex): Stage[];
}

type Binding = { contract: string; method: string; input: string; output: string; useCase: string; execute: string; adapter: string; rule: string };
export type StagePlan = { kind: "contract"; moduleId: string; goal: string; evidence: { path: string; symbol: string }[]; binding: Binding; steps: { idea: Idea; title: string; limitation: string }[] } | StructuredDecisionPlan | RemoteClassifierPlan;
type Idea = "direct-call" | "inject-function" | "interface" | "async" | "use-case" | "adapter" | "test-double" | "checkpoint";
const IDEAS: Idea[] = ["direct-call", "inject-function", "interface", "async", "use-case", "adapter", "test-double", "checkpoint"];
const TITLES = ["Chamar a regra", "Trocar a função", "Nomear o contrato", "Aceitar espera", "Criar o caso de uso", "Conectar a implementação", "Testar com uma substituta", "Checkpoint: reconstruir o contrato"];
const LIMITS = [
  "Quem tria ainda escolhe as regras por conta própria; precisamos poder trocar essa decisão.",
  "Uma função solta não nomeia o compromisso que outras implementações devem cumprir.",
  "O contrato síncrono exclui classificadores que esperam rede ou disco.",
  "O chamador ainda precisa montar a chamada; falta um caso de uso com a dependência guardada.",
  "O caso de uso aceita o contrato, mas a regra determinística ainda não foi conectada a ele.",
  "A implementação real funciona; falta provar que o caso de uso aceita uma substituta em teste.",
  "Agora reúna as peças do módulo sem o ponto de partida.",
  "Compare sua reconstrução com o código real.",
];
export const isModule2Goal = (goal: string): boolean => /(?:^|\W)(?:triageclassifier|triageticket)(?:$|\W)|m[oó]dulo\s*2|module\s*2|contrato.*classificador|classificador.*contrato/i.test(goal);
const QUICK: Record<Idea, string> = {
  "direct-call": "A função triage recebe um ticket e devolve a categoria calculada pela regra anterior.",
  "inject-function": "O classificador chega como parâmetro. Assim o chamador decide qual regra usar.",
  interface: "TriageClassifier nomeia a operação classify que qualquer classificador deve oferecer.",
  async: "A resposta passa a ser Promise<Category>; a mesma porta serve para trabalho que leva tempo.",
  "use-case": "TriageTicket guarda o classificador recebido e delega a ele cada ticket.",
  adapter: "A classe determinística cumpre o contrato e reaproveita classify do módulo anterior.",
  "test-double": "Um classificador falso devolve uma resposta controlada e registra o ticket recebido.",
  checkpoint: "Reconstrua contrato, caso de uso, implementação e substituta de teste do editor vazio.",
};
const INSTRUCTIONS: Record<Idea, string> = {
  "direct-call": "Crie triage(input) para chamar classify do código pronto e devolver sua categoria.",
  "inject-function": "Faça triage receber a função classifier e usá-la no lugar da regra fixa.",
  interface: "Declare TriageClassifier com classify(input) e use esse contrato em triage.",
  async: "Faça o contrato e triage devolverem Promise<Category>; use async na função.",
  "use-case": "Substitua a função solta pela classe TriageTicket, recebendo o contrato no construtor e delegando em execute.",
  adapter: "Crie DeterministicTriageClassifier que implementa o contrato e chama classify.",
  "test-double": "Crie FakeClassifier que implementa o contrato, devolve uma resposta fixa e registra as chamadas.",
  checkpoint: "Reconstrua port.ts do zero com contrato assíncrono, TriageTicket, implementação determinística e fake.",
};
const lineMatch = (b: Binding): Record<Idea, string> => ({
  "direct-call": `return ${b.rule}(input)`,
  "inject-function": "return classifier(input)",
  interface: `export interface ${b.contract}`,
  async: `Promise<${b.output}>`,
  "use-case": "constructor(private readonly classifier",
  adapter: `implements ${b.contract}`,
  "test-double": "this.calls.push(input)",
  checkpoint: `export class ${b.useCase}`,
});

function contractNarrative(idea: Idea, binding: Binding, previous: string, limitation: string, realSymbol: string, realPath: string) {
  const b = binding;
  const needs: Record<Idea, [string, string, string, string]> = {
    "direct-call": ["Na triagem real, um ticket precisa chegar à regra antes de receber uma categoria.", `crie triage para chamar ${b.rule}.`, "o ticket devolve a categoria calculada.", `O return chama ${b.rule}(input) e entrega sua resposta ao chamador.`],
    "inject-function": ["Na aplicação, podemos querer escolher outra regra sem editar quem faz a chamada.", "receba a função classifier como parâmetro.", "o chamador escolhe a regra usada para cada chamada.", "O parâmetro classifier substitui a chamada fixa; triage repassa o mesmo input."],
    interface: ["Com mais de um classificador, todos precisam oferecer a mesma operação.", `declare ${b.contract} e use seu método ${b.method}.`, "qualquer objeto com essa operação pode classificar o ticket.", `A interface ${b.contract} define ${b.method}(input); triage chama esse método no objeto recebido.`],
    async: ["Um classificador pode consultar rede ou disco antes de responder.", "faça o contrato e triage devolverem uma Promise.", "a mesma chamada pode aguardar uma resposta futura.", `Promise<${b.output}> representa uma resposta futura; async permite que triage a devolva.`],
    "use-case": ["Cada ticket passa pelo mesmo fluxo de triagem da aplicação.", `crie ${b.useCase} e guarde o classificador no construtor.`, `execute classifica cada ticket com a dependência recebida.`, `O construtor guarda classifier; ${b.execute}(input) delega a chamada ao método ${b.method}.`],
    adapter: ["Para usar a regra já construída, precisamos ligá-la ao contrato do caso de uso.", `crie ${b.adapter} implementando ${b.contract}.`, "o caso de uso pode usar a regra determinística existente.", `implements verifica o contrato; ${b.method} chama ${b.rule}(input) e devolve o resultado.`],
    "test-double": ["No teste, precisamos controlar a resposta e verificar qual ticket foi enviado.", "crie FakeClassifier com resposta fixa e registro de chamadas.", "o teste observa a delegação sem depender da regra real.", "FakeClassifier guarda input em calls e devolve answer; TriageTicket aceita a substituta pelo mesmo contrato."],
    checkpoint: ["As peças do módulo já funcionam juntas.", "reconstrua o conjunto a partir do editor vazio.", "o contrato, o caso de uso e as implementações voltam a funcionar juntos.", "Reúna as operações praticadas nas etapas anteriores."],
  };
  const [need, task, outcome, code] = needs[idea];
  return stageNarrative({ previous, need, limitation, task, outcome, code, detail: `No projeto real, ${realSymbol} aparece em ${realPath}. O Replay pratica esta relação com uma versão menor.` });
}

/** Planner reads declarations from the pinned source and returns pedagogy only, never stages. */
export class StagePlanner {
  plan(goal: string, journey: Journey, moduleId: string, index: RepositoryIndex): StagePlan {
    if (journey.repo.owner !== "marcelotaparelli" || journey.repo.name !== "ops-triage-ai") throw new Error("Este gerador atende somente o repositório acompanhado nesta jornada.");
    const module = journey.modules.find((m) => m.id === moduleId);
    const chapter = journey.stages.find((s) => s.moduleId === moduleId && s.kind === "chapter");
    if (!module || !chapter || module.stageIds.length !== 1) throw new Error("Este módulo não é um capítulo legado único.");
    if (chapter.referenceCode.some((file) => /implements TriageClassifier/.test(file.content) && /fetchImpl/.test(file.content)) &&
        chapter.referenceCode.some((file) => /export function parse\w+Result\(/.test(file.content))) return planRemoteClassifier(goal, journey, moduleId, chapter, index);
    if (chapter.originalCodeRefs.some((ref) => ref.symbol === "TriageDecision")) return planStructuredDecision(goal, journey, moduleId, chapter, index);
    if (!chapter.referenceCode.some((file) => file.path === "triage-classifier.ts")) throw new Error("A estrutura solicitada ainda não é suportada pelo gerador de percursos deste repositório.");
    if (!isModule2Goal(goal)) throw new Error("O objetivo ainda não corresponde ao contrato deste módulo.");
    const evidence = ["TriageClassifier", "TriageTicket", "DeterministicTriageClassifier"].map((symbol) => {
      const declaration = index.declarations.find((d) => d.symbol === symbol && d.container === null);
      if (!declaration) throw new Error(`Declaração ${symbol} ausente no SHA fixado.`);
      return { path: declaration.path, symbol };
    });
    const method = index.declarations.find((d) => d.symbol === "classify" && d.container === "DeterministicTriageClassifier");
    if (!method) throw new Error("Método de classificação ausente no SHA fixado.");
    evidence.push({ path: method.path, symbol: "classify" });
    const [port, useCase, adapter] = evidence.map((e) => index.files.get(e.path) ?? "");
    if (!/classify\(input: TicketInput\): Promise<ClassifierResult>/.test(port ?? "") || !/classifier\.classify\(input\)/.test(useCase ?? "") || !/implements TriageClassifier/.test(adapter ?? "")) {
      throw new Error("As relações entre contrato, caso de uso e implementação não foram confirmadas no código real.");
    }
    const legacy = chapter.referenceCode;
    const portCode = legacy.find((f) => f.path === "triage-classifier.ts")?.content ?? "";
    const caseCode = legacy.find((f) => f.path === "triage-ticket.ts")?.content ?? "";
    const adapterCode = legacy.find((f) => f.path === "deterministic-triage-classifier.ts")?.content ?? "";
    const ruleCode = legacy.find((f) => f.path === "triage.ts")?.content ?? "";
    const contract = /export interface (\w+)\s*\{\s*(\w+)\(input: (\w+)\): Promise<(\w+)>/.exec(portCode);
    const useCaseClass = /export class (\w+)/.exec(caseCode);
    const execute = /async (\w+)\(input: \w+\): Promise<\w+>/.exec(caseCode);
    const adapterClass = /export class (\w+) implements (\w+)/.exec(adapterCode);
    const rule = /export function (\w+)\(input: \w+\): \w+/.exec(ruleCode);
    if (!contract || !useCaseClass || !execute || !adapterClass || !rule || adapterClass[2] !== contract[1]) throw new Error("Não foi possível extrair o contrato executável do capítulo legado.");
    const binding: Binding = { contract: contract[1]!, method: contract[2]!, input: contract[3]!, output: contract[4]!, useCase: useCaseClass[1]!, execute: execute[1]!, adapter: adapterClass[1]!, rule: rule[1]! };
    return { kind: "contract", moduleId, goal, evidence, binding, steps: IDEAS.map((idea, i) => ({ idea, title: TITLES[i]!, limitation: LIMITS[i]! })) };
  }

}

const file = (content: string): CodeFile => ({ path: "port.ts", content: content.trim() + "\n" });
function versionsOf(b: Binding): Record<Exclude<Idea, "checkpoint">, string> {
  const imports = `import { ${b.rule}, type ${b.input}, type ${b.output} } from "./triage.ts";`;
  const port = (result: string) => `export interface ${b.contract} { ${b.method}(input: ${b.input}): ${result}; }`;
  const useCase = `export class ${b.useCase} {\n  constructor(private readonly classifier: ${b.contract}) {}\n  async ${b.execute}(input: ${b.input}): Promise<${b.output}> {\n    return this.classifier.${b.method}(input);\n  }\n}`;
  const adapter = `export class ${b.adapter} implements ${b.contract} {\n  async ${b.method}(input: ${b.input}): Promise<${b.output}> {\n    return ${b.rule}(input);\n  }\n}`;
  const fake = `export class FakeClassifier implements ${b.contract} {\n  readonly calls: ${b.input}[] = [];\n  constructor(private readonly answer: ${b.output}) {}\n  async ${b.method}(input: ${b.input}): Promise<${b.output}> { this.calls.push(input); return this.answer; }\n}`;
  return {
    "direct-call": `${imports}\nexport function triage(input: ${b.input}): ${b.output} {\n  return ${b.rule}(input);\n}`,
    "inject-function": `${imports}\nexport function triage(input: ${b.input}, classifier: (input: ${b.input}) => ${b.output}): ${b.output} {\n  return classifier(input);\n}`,
    interface: `${imports}\n${port(b.output)}\nexport function triage(input: ${b.input}, classifier: ${b.contract}): ${b.output} {\n  return classifier.${b.method}(input);\n}`,
    async: `${imports}\n${port(`Promise<${b.output}>`)}\nexport async function triage(input: ${b.input}, classifier: ${b.contract}): Promise<${b.output}> {\n  return classifier.${b.method}(input);\n}`,
    "use-case": `${imports}\n${port(`Promise<${b.output}>`)}\n${useCase}`,
    adapter: `${imports}\n${port(`Promise<${b.output}>`)}\n${useCase}\n${adapter}`,
    "test-double": `${imports}\n${port(`Promise<${b.output}>`)}\n${useCase}\n${adapter}\n${fake}`,
  };
}
const version = (idea: Idea, versions: Record<Exclude<Idea, "checkpoint">, string>): string => versions[idea === "checkpoint" ? "test-double" : idea];

const tests: Record<Idea, string> = {
  "direct-call": 'import { test, expect } from "ownr:test";\nimport { triage } from "./port.ts";\ntest("usa a regra", () => expect(triage({ title: "site down", description: "" })).toBe("INCIDENT"));',
  "inject-function": 'import { test, expect } from "ownr:test";\nimport { triage } from "./port.ts";\ntest("aceita outra função", () => expect(triage({ title: "", description: "" }, () => "ACCESS")).toBe("ACCESS"));',
  interface: 'import { test, expect } from "ownr:test";\nimport { triage } from "./port.ts";\ntest("aceita objeto pelo contrato", () => expect(triage({ title: "", description: "" }, { classify: () => "BUG" })).toBe("BUG"));',
  async: 'import { test, expect } from "ownr:test";\nimport { triage } from "./port.ts";\ntest("espera resposta assíncrona", async () => { const result = triage({ title: "", description: "" }, { classify: async () => "ACCESS" }); expect(result).toBeInstanceOf(Promise); expect(await result).toBe("ACCESS"); });',
  "use-case": 'import { test, expect } from "ownr:test";\nimport { TriageTicket } from "./port.ts";\ntest("caso de uso delega ao contrato", async () => { const input = { title: "", description: "" }; let seen; const service = new TriageTicket({ classify: async (value) => { seen = value; return "BUG"; } }); expect(await service.execute(input)).toBe("BUG"); expect(seen).toBe(input); });',
  adapter: 'import { test, expect } from "ownr:test";\nimport { TriageTicket, DeterministicTriageClassifier } from "./port.ts";\ntest("implementação determinística encaixa", async () => expect(await new TriageTicket(new DeterministicTriageClassifier()).execute({ title: "site down", description: "" })).toBe("INCIDENT"));',
  "test-double": 'import { test, expect } from "ownr:test";\nimport { TriageTicket, FakeClassifier } from "./port.ts";\ntest("substituta registra a chamada", async () => { const input = { title: "", description: "" }; const fake = new FakeClassifier("ACCESS"); expect(await new TriageTicket(fake).execute(input)).toBe("ACCESS"); expect(fake.calls).toEqual([input]); });',
  checkpoint: 'import { test, expect } from "ownr:test";\nimport { TriageTicket, DeterministicTriageClassifier, FakeClassifier } from "./port.ts";\ntest("reconstrói o módulo", async () => { const input = { title: "site down", description: "" }; expect(await new TriageTicket(new DeterministicTriageClassifier()).execute(input)).toBe("INCIDENT"); const fake = new FakeClassifier("ACCESS"); expect(await new TriageTicket(fake).execute(input)).toBe("ACCESS"); expect(fake.calls).toEqual([input]); });',
};

const ideaConcept: Partial<Record<Idea, string>> = { "inject-function": "dependency-inversion", interface: "interface-contract", async: "async-contract", "use-case": "use-case", "test-double": "test-double" };
const tools: Partial<Record<Idea, { id: string; name: string; summary: string; example: string }>> = {
  "inject-function": { id: "function-param", name: "Função como parâmetro", summary: "O chamador escolhe a função usada.", example: 'function apply(n: number, f: (n: number) => number) { return f(n); }' },
  interface: { id: "interface", name: "interface", summary: "Nomeia um contrato entre objetos.", example: 'interface Greeter { greet(): string }\nconst g: Greeter = { greet: () => "oi" };' },
  async: { id: "async", name: "Promise / async", summary: "Uma operação pode terminar mais tarde.", example: 'async function answer(): Promise<number> { return 1; }' },
  "use-case": { id: "constructor", name: "constructor", summary: "Guarda uma dependência escolhida pelo chamador.", example: 'class Greeter { constructor(private readonly text: string) {} greet() { return this.text; } }' },
  adapter: { id: "implements", name: "implements", summary: "Confere se a classe cumpre a interface.", example: 'interface Greeter { greet(): string }\nclass Hi implements Greeter { greet() { return "oi"; } }' },
  "test-double": { id: "fake", name: "Fake de teste", summary: "Uma implementação simples do contrato, controlada pelo teste.", example: 'interface Clock { now(): number }\nclass FixedClock implements Clock { now() { return 10; } }' },
};

const architecture = (idea: Idea) => {
  const position = IDEAS.indexOf(idea);
  const nodes = [
    { id: "ticket", label: "TicketInput", kind: "data" as const, col: 0, row: 0 },
    { id: "category", label: "Category", kind: "data" as const, col: 2, row: 0 },
    ...(position >= 2 ? [{ id: "port", label: "TriageClassifier", kind: "interface" as const, col: 1, row: 0 }] : []),
    ...(position >= 4 ? [{ id: "use-case", label: "TriageTicket", kind: "class" as const, col: 1, row: 1 }] : []),
    ...(position >= 5 ? [{ id: "adapter", label: "DeterministicTriageClassifier", kind: "class" as const, col: 2, row: 1 }] : []),
  ];
  const edges = [
    { from: "ticket", to: "category", rel: "flows_to" as const },
    ...(position >= 2 ? [{ from: "port", to: "category", rel: "creates" as const }] : []),
    ...(position >= 4 ? [{ from: "use-case", to: "port", rel: "depends_on" as const }] : []),
    ...(position >= 5 ? [{ from: "adapter", to: "port", rel: "implements" as const }] : []),
  ];
  return { nodes, edges };
};

/** Generator turns each planned idea into a complete runnable exercise. */
export class StageGenerator implements StageGenerationProvider {
  generate(plan: StagePlan, journey: Journey, index: RepositoryIndex): Stage[] {
    if (plan.kind === "remote-classifier") return generateRemoteClassifier(plan, journey, index);
    if (plan.kind === "structured-decision") return generateStructuredDecision(plan, journey, index);
    const chapter = journey.stages.find((s) => s.moduleId === plan.moduleId && s.kind === "chapter");
    const support = chapter?.referenceCode.find((f) => f.path === "triage.ts");
    if (!chapter || !support) throw new Error("A base do classificador anterior não foi encontrada.");
    const previousIds = journey.stages.filter((s) => s.order < chapter.order).map((s) => s.id);
    const output: Stage[] = [];
    const versions = versionsOf(plan.binding);
    for (const [i, item] of plan.steps.entries()) {
      const checkpoint = item.idea === "checkpoint";
      const content = version(item.idea, versions);
      const before = i === 0 ? "" : version(plan.steps[i - 1]!.idea, versions);
      const concept = ideaConcept[item.idea];
      const known = plan.steps.slice(0, i).flatMap((s) => ideaConcept[s.idea] ? [ideaConcept[s.idea]!] : []);
      const refSymbol = item.idea === "direct-call" || item.idea === "inject-function" ? "classify" : item.idea === "use-case" || item.idea === "checkpoint" ? "TriageTicket" : item.idea === "adapter" ? "DeterministicTriageClassifier" : "TriageClassifier";
      const evidence = plan.evidence.find((e) => e.symbol === refSymbol)!;
      const declaration = index.declarations.find((d) => d.path === evidence.path && d.symbol === evidence.symbol && (evidence.symbol !== "classify" || d.container === "DeterministicTriageClassifier"))!;
      const source = index.files.get(evidence.path)!;
      const reference: OriginalCodeReference = {
        path: evidence.path, symbol: evidence.symbol, startLine: declaration.startLine, endLine: declaration.endLine,
        replayFile: "port.ts", ...(refSymbol === "classify" ? { replaySymbol: "triage" } : {}), note: "O Replay reduz o resultado à categoria; o projeto real também carrega decisão, prioridade e política.",
        snippet: source.split("\n").slice(declaration.startLine - 1, declaration.endLine).join("\n"),
        url: `${journey.repo.url}/blob/${journey.repo.sha}/${evidence.path}#L${declaration.startLine}-L${declaration.endLine}`,
      };
      const id = `${journey.id}.${plan.moduleId}-${checkpoint ? "99" : String(i + 1).padStart(2, "0")}`;
      const narrative = contractNarrative(item.idea, plan.binding, i === 0 ? "No módulo anterior, construímos a regra classify que recebe um ticket e calcula sua categoria." : `Na etapa anterior, ${QUICK[plan.steps[i - 1]!.idea]}`, i === 0 ? "A regra sozinha não é chamada pelo fluxo da aplicação." : plan.steps[i - 1]!.limitation, evidence.symbol, evidence.path);
      const stage = Stage.parse({
        id, order: chapter.order + i, moduleId: plan.moduleId, kind: checkpoint ? "checkpoint" : "micro", title: item.title,
        goal: checkpoint ? "Reconstruir o contrato, caso de uso e implementação do zero." : `Aprender ${item.title.toLowerCase()} a partir do limite anterior.`,
        context: narrative.context,
        problem: narrative.problem,
        examples: [], requirements: checkpoint ? ["Defina o contrato assíncrono.", "Injete o contrato em TriageTicket.", "Conecte a implementação determinística.", "Crie uma substituta que registre chamadas."] : [],
        estimatedMinutes: checkpoint ? 5 : 3, introduces: concept && !checkpoint ? [concept] : [], prerequisites: known, architecture: architecture(item.idea),
        referenceCode: [file(content)], lineNotes: [{ match: lineMatch(plan.binding)[item.idea], note: narrative.quick }],
        explanation: [{ id: item.idea, ...(concept ? { conceptId: concept } : {}), title: item.title, quick: narrative.quick, normal: narrative.normal }],
        originalCodeRefs: [reference],
        exercise: { instructions: INSTRUCTIONS[item.idea], starterFiles: [{ path: "port.ts", content: checkpoint || i === 0 ? "" : file(before).content }], solutionFiles: [file(content)], supportFiles: [support], expose: [], testFile: { path: "tests.ts", content: tests[item.idea] }, ...(item.idea === "async" ? { typecheck: { files: [{ path: "check.ts", content: 'import { Category } from "./triage.ts";\nimport type { TriageClassifier } from "./port.ts";\nconst classifier: TriageClassifier = { classify: async () => Category.ACCESS };\n' }] } } : {}) },
        toolbox: tools[item.idea] ? [tools[item.idea]] : [],
        tutorContext: { relevantFiles: ["port.ts", evidence.path], concepts: [...known, ...(concept ? [concept] : [])], previousStages: [...previousIds, ...output.map((s) => s.id)] },
        completionCriteria: [{ kind: "tests_pass" }], checkpoint: checkpoint ? { question: "Por que TriageTicket recebe o contrato?", answer: "Para trocar implementações sem alterar o caso de uso; o ponto de montagem escolhe o classificador." } : undefined,
        limitation: checkpoint ? undefined : item.limitation,
        summary: { added: [item.title], why: item.limitation, flow: architecture(item.idea).nodes.map((n) => n.label) },
      });
      output.push(stage);
    }
    return output;
  }
}

export function withGeneratedModule(journey: Journey, moduleId: string, generated: Stage[]): Journey {
  const chapter = journey.stages.find((s) => s.moduleId === moduleId && s.kind === "chapter");
  if (!chapter) throw new Error("Capítulo legado indisponível.");
  const all = [...journey.stages.filter((s) => s.order < chapter.order), ...generated, ...journey.stages.filter((s) => s.order > chapter.order)];
  const stages = all.map((s, i) => ({ ...s, order: i + 1, tutorContext: { ...s.tutorContext, previousStages: all.slice(0, i).map((prior) => prior.id) } }));
  return { ...journey, modules: journey.modules.map((m) => m.id === moduleId ? { ...m, stageIds: generated.map((s) => s.id) } : m), stages };
}

/** Validator checks the complete candidate before it can replace the legacy chapter. */
export class StageValidator {
  constructor(private readonly checker: TypeChecker) {}
  async validate(journey: Journey, moduleId: string, generated: Stage[], index: RepositoryIndex): Promise<void> {
    const problems = validateJourney(journey);
    const stages = generated;
    if (stages.length < 2 || stages.at(-1)?.kind !== "checkpoint") problems.push("O módulo precisa terminar em checkpoint.");
    if (stages.at(-1)?.exercise?.solutionFiles[0]?.content !== stages.at(-2)?.exercise?.solutionFiles[0]?.content) problems.push("Checkpoint difere da versão final do módulo.");
    for (const [i, stage] of stages.entries()) {
      const exercise = stage.exercise;
      if (!exercise) { problems.push(`${stage.id}: exercício ausente`); continue; }
      if (stage.introduces.length > 1) problems.push(`${stage.id}: mais de uma ideia nova`);
      if (stage.kind === "micro") {
        const before = i ? stages[i - 1]?.exercise?.solutionFiles[0]?.content ?? "" : "";
        const after = exercise.solutionFiles[0]?.content ?? "";
        const novel = noveltyLines(before, after).length;
        if (novel > 5 && (!stage.noveltyException || novel >= 8)) problems.push(`${stage.id}: ${novel} linhas novas excedem o orçamento`);
        if (exercise.starterFiles[0]?.content.trim() !== before.trim()) problems.push(`${stage.id}: workspace não cumulativo`);
        if (i && !stage.problem.includes(stages[i - 1]!.limitation ?? "\u0000")) problems.push(`${stage.id}: problema não nasce da limitação anterior`);
        const previousNodes = new Set(stages[i - 1]?.architecture?.nodes.map((n) => n.id) ?? []);
        const currentNodes = new Set(stage.architecture?.nodes.map((n) => n.id) ?? []);
        for (const node of previousNodes) if (!currentNodes.has(node)) problems.push(`${stage.id}: arquitetura regrediu em ${node}`);
      } else if (exercise.starterFiles.some((f) => f.content.trim())) problems.push(`${stage.id}: checkpoint não começa vazio`);
      const earlierConcepts = new Set(stages.slice(0, i).flatMap((s) => s.introduces));
      for (const concept of stage.tutorContext.concepts) if (!earlierConcepts.has(concept) && !stage.introduces.includes(concept)) problems.push(`${stage.id}: tutor antecipa ${concept}`);
      for (const ref of stage.originalCodeRefs) {
        const source = index.files.get(ref.path);
        const declaration = index.declarations.find((d) => d.path === ref.path && d.symbol === ref.symbol && d.startLine === ref.startLine && d.endLine === ref.endLine);
        if (!source || source.split("\n").slice(ref.startLine - 1, ref.endLine).join("\n") !== ref.snippet || !declaration) problems.push(`${stage.id}: referência real inválida`);
      }
      for (const node of stage.architecture?.nodes ?? []) if (resolveNode(node, journey, index).status !== "mapped") problems.push(`${stage.id}: arquitetura sem referência real para ${node.label}`);
      try {
        const result = await executeModules(await prepareExercise(exercise, exercise.solutionFiles));
        if (!result.tests.length || result.tests.some((t) => !t.passed)) problems.push(`${stage.id}: solução não passa os testes: ${result.tests.filter((t) => !t.passed).map((t) => t.error).join("; ")}`);
        let startingPasses = false;
        try {
          const starting = await executeModules(await prepareExercise(exercise, exercise.starterFiles));
          startingPasses = starting.tests.length > 0 && starting.tests.every((t) => t.passed);
        } catch { /* Missing code is an expected failing starting point. */ }
        if (startingPasses && exercise.typecheck) startingPasses = (await this.checker.check([...completeExercise(exercise, exercise.starterFiles), ...exercise.typecheck.files])).length === 0;
        if (startingPasses) problems.push(`${stage.id}: ponto de partida já passa`);
        const diagnostics = await this.checker.check([...completeExercise(exercise, exercise.solutionFiles), ...(exercise.typecheck?.files ?? [])]);
        if (diagnostics.length) problems.push(`${stage.id}: ${diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
      } catch (error) { problems.push(`${stage.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    problems.push(...await snippetProblems(shownSnippets(generated), this.checker));
    if (problems.length) throw new Error("Geração rejeitada: " + problems.join(" | "));
  }
}

export class ModuleGenerationService {
  constructor(private readonly root: string, private readonly planner: StagePlanner, private readonly provider: StageGenerationProvider, private readonly validator: StageValidator) {}
  path(journeyId: string, moduleId: string): string { return join(this.root, journeyId, `${moduleId}.json`); }
  restore(journey: Journey): Journey {
    let current = journey;
    for (const module of journey.modules) {
      const path = this.path(journey.id, module.id);
      if (!existsSync(path)) continue;
      const saved = JSON.parse(readFileSync(path, "utf8")) as { sha: string; stages: unknown[] };
      if (saved.sha !== journey.repo.sha) continue;
      current = withGeneratedModule(current, module.id, saved.stages.map((s) => Stage.parse(s)));
    }
    return current;
  }
  async generate(journey: Journey, moduleId: string, goal: string, index: RepositoryIndex): Promise<Journey> {
    const plan = this.planner.plan(goal, journey, moduleId, index);
    const generated = this.provider.generate(plan, journey, index);
    const candidate = withGeneratedModule(journey, moduleId, generated);
    await this.validator.validate(candidate, moduleId, generated, index);
    const path = this.path(journey.id, moduleId);
    mkdirSync(join(this.root, journey.id), { recursive: true });
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ sha: journey.repo.sha, goal, plan, stages: generated }, null, 2));
    renameSync(temp, path);
    return candidate;
  }
}
