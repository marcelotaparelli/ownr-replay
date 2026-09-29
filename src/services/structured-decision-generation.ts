import type { Journey } from "../domain/journey.ts";
import { Stage, type CodeFile, type OriginalCodeReference } from "../domain/stage.ts";
import type { RepositoryIndex, Declaration } from "./code-map.ts";
import { stageNarrative } from "./stage-narrative.ts";

type Evidence = { path: string; symbol: string; container: string | null };
export type StructuredDecisionPlan = {
  kind: "structured-decision";
  moduleId: string;
  goal: string;
  evidence: Evidence[];
  names: { lookup: string; result: string; decision: string; source: string; reason: string; decide: string; category: string; team: string };
  entries: { category: string; team: string }[];
  sourceValues: string[];
  reasonValues: string[];
};

const declaration = (index: RepositoryIndex, symbol: string, container: string | null = null): Declaration => {
  const found = index.declarations.find((item) => item.symbol === symbol && item.container === container);
  if (!found) throw new Error(`Declaração ${symbol} ausente no SHA fixado.`);
  return found;
};

/** Recognizes the bounded result → lookup → decision pattern in a legacy chapter. */
export function planStructuredDecision(goal: string, journey: Journey, moduleId: string, chapter: Stage, index: RepositoryIndex): StructuredDecisionPlan {
  const refs = chapter.originalCodeRefs;
  const findRef = (symbol: string) => refs.find((ref) => ref.symbol === symbol);
  const resultRef = findRef("ClassifierResult");
  const tableRef = findRef("SUGGESTED_TEAM_BY_CATEGORY");
  const lookupRef = tableRef ? { path: tableRef.path, symbol: "suggestedTeamForCategory" } : undefined;
  const decisionRef = findRef("TriageDecision");
  const decideRef = findRef("decideSingle");
  if (!resultRef || !lookupRef || !decisionRef || !decideRef || !/m[oó]dulo\s*3|module\s*3|decis[aã]o|resultado estruturado|revis[aã]o humana|suggestedTeamForCategory|TriageDecision/i.test(goal)) {
    throw new Error("Objetivo ou padrão de resultado, consulta e decisão indisponível neste capítulo.");
  }
  const source = (path: string) => index.files.get(path) ?? "";
  const resultText = source(resultRef.path);
  const lookupText = source(lookupRef.path);
  const decisionText = source(decisionRef.path);
  const policyText = source(decideRef.path);
  const result = /export interface (ClassifierResult)\s*\{[^}]*?category:\s*(\w+);[^}]*?suggestedTeam:\s*(\w+);[^}]*?confidence:\s*\w+;/.exec(resultText);
  const lookup = /export function (\w+)\(category:\s*\w+\):\s*\w+\s*\{\s*return\s+(\w+)\[category\];/.exec(lookupText);
  const map = /const (\w+):\s*Readonly<Record<\w+,\s*\w+>>\s*=\s*\{([\s\S]*?)\};/.exec(lookupText);
  const decision = /export interface (\w+) extends (\w+)\s*\{[\s\S]*?requiresHumanReview:\s*boolean;[\s\S]*?decisionSource:\s*(\w+);[\s\S]*?reviewReasons:\s*(\w+)\[\];/.exec(decisionText);
  const sourceEnum = /export enum (\w+)\s*\{([\s\S]*?)\}/.exec(decisionText);
  const reasonEnum = [...decisionText.matchAll(/export enum (\w+)\s*\{([\s\S]*?)\}/g)].find((item) => item[1] === decision?.[4]);
  const decide = /\b(\w+)\(result:\s*ClassifierResult,\s*source:\s*SingleDecisionSource\):\s*TriageDecision/.exec(policyText);
  const entries = [...(map?.[2] ?? "").matchAll(/\[(\w+)\.(\w+)\]:\s*(\w+)\.(\w+)/g)].map((match) => ({ category: match[2]!, team: match[4]! }));
  const enumValues = (body: string) => [...body.matchAll(/(\w+)\s*=\s*"\1"/g)].map((match) => match[1]!);
  const sourceValues = enumValues(sourceEnum?.[2] ?? "");
  const reasonValues = enumValues(reasonEnum?.[2] ?? "");
  const categoryValues = enumValues(/export enum Category\s*\{([\s\S]*?)\}/.exec(resultText)?.[1] ?? "");
  const reduced = chapter.referenceCode.find((file) => file.path === "triage.ts");
  const reducedCategories = enumValues(/export enum Category\s*\{([\s\S]*?)\}/.exec(reduced?.content ?? "")?.[1] ?? "");
  const reducedTeams = enumValues(/export enum SuggestedTeam\s*\{([\s\S]*?)\}/.exec(reduced?.content ?? "")?.[1] ?? "");
  if (!result || !lookup || !map || !decision || !sourceEnum || !reasonEnum || !decide || !reduced || result[1] !== decision[2] || lookup[2] !== map[1] || decision[3] !== sourceEnum[1] ||
      !/confidence\s*===\s*0\.5/.test(policyText) || !/Priority\.HIGH/.test(policyText) || !/Priority\.CRITICAL/.test(policyText) || !/Risk\.HIGH/.test(policyText) ||
      !/reviewReasons\.length\s*>\s*0/.test(policyText) || !/\.\.\.result/.test(policyText) ||
      !reducedCategories.length || reducedCategories.some((value) => !categoryValues.includes(value) || !entries.some((entry) => entry.category === value && reducedTeams.includes(entry.team))) ||
      !sourceValues.includes("DETERMINISTIC") || !sourceValues.includes("LLM") || !reasonValues.includes("LOW_CONFIDENCE") || !reasonValues.includes("HIGH_SEVERITY")) {
    throw new Error("As relações de resultado, tabela e revisão não foram confirmadas no código do SHA fixado.");
  }
  const evidence = [resultRef, lookupRef, decisionRef, decideRef].map((ref) => {
    const match = index.declarations.find((item) => item.path === ref.path && item.symbol === ref.symbol);
    if (!match) throw new Error(`Referência ${ref.symbol} ausente no SHA fixado.`);
    return { path: match.path, symbol: match.symbol, container: match.container };
  });
  for (const symbol of [sourceEnum[1]!, reasonEnum[1]!, result[2]!, result[3]!]) {
    const found = declaration(index, symbol);
    evidence.push({ path: found.path, symbol, container: null });
  }
  return { kind: "structured-decision", moduleId, goal, evidence, names: { lookup: lookup[1]!, result: result[1]!, decision: decision[1]!, source: sourceEnum[1]!, reason: reasonEnum[1]!, decide: decide[1]!, category: result[2]!, team: result[3]! }, entries: reducedCategories.map((category) => entries.find((entry) => entry.category === category)!), sourceValues: sourceValues.filter((value) => value === "DETERMINISTIC" || value === "LLM"), reasonValues: reasonValues.filter((value) => value === "LOW_CONFIDENCE" || value === "HIGH_SEVERITY") };
}

const file = (content: string): CodeFile => ({ path: "decision.ts", content: content.trim() + "\n" });

const STEPS = [
  { title: "Roteamento inicial", concept: undefined, limitation: "Uma condição isolada não cobre todas as categorias.", instruction: "Crie a função de time sugerido para INCIDENT e um valor padrão.", quick: "A categoria já pode orientar o primeiro encaminhamento.", ref: "suggestedTeamForCategory" },
  { title: "Tabela completa por categoria", concept: "record-type", limitation: "O time está definido; falta marcar a origem da decisão.", instruction: "Troque a condição por um Readonly<Record<Category, SuggestedTeam>> com todas as categorias.", quick: "Record exige uma entrada para cada categoria, e a função só consulta a tabela.", ref: "suggestedTeamForCategory" },
  { title: "Origem da decisão", concept: undefined, limitation: "A origem está explícita; ainda faltam nomes para os motivos de revisão.", instruction: "Declare DecisionSource com as duas origens usadas neste percurso.", quick: "DecisionSource nomeia as duas origens que uma decisão poderá registrar.", ref: "DecisionSource" },
  { title: "Motivos de revisão", concept: "human-review", limitation: "Os motivos têm nome; falta definir a forma da decisão que os carrega.", instruction: "Declare HumanReviewReason para baixa confiança e alta severidade.", quick: "Motivos explícitos explicam por que alguém deve revisar.", ref: "HumanReviewReason" },
  { title: "Forma da decisão", concept: "structured-result", limitation: "O tipo existe; falta construir uma decisão concreta.", instruction: "Declare TriageDecision estendendo ClassifierResult e acrescente revisão, origem e motivos.", quick: "A decisão conserva o resultado e acrescenta metadados para ação e revisão.", ref: "TriageDecision" },
  { title: "Decisão sem alerta", concept: undefined, limitation: "Uma resposta confiante funciona; baixa confiança ainda passa sozinha.", instruction: "Crie decideSingle: copie o resultado, registre a origem e inicie sem motivos.", quick: "Um resultado confiante e de baixa severidade dispensa revisão.", ref: "decideSingle" },
  { title: "Baixa confiança pede revisão", concept: "confidence", limitation: "A incerteza pede revisão; alta severidade ainda não pede.", instruction: "Inclua LOW_CONFIDENCE quando confidence for 0.5 e derive requiresHumanReview da lista.", quick: "Confiança 0.5 indica que a decisão precisa de uma pessoa.", ref: "decideSingle" },
  { title: "Alta severidade pede revisão", concept: undefined, limitation: "Agora reconstrua a decisão completa sem o ponto de partida.", instruction: "Inclua HIGH_SEVERITY para prioridade HIGH ou CRITICAL, ou risco HIGH, após LOW_CONFIDENCE.", quick: "A ordem dos motivos permanece estável mesmo quando dois alertas ocorrem juntos.", ref: "decideSingle" },
] as const;

const DECISION_NARRATIVE = [
  ["No atendimento real, a categoria precisa apontar para um time responsável.", "crie a função de encaminhamento inicial.", "INCIDENT vai para infraestrutura e os demais casos apontam para o time HUMAN_REVIEW.", "A condição compara category com INCIDENT e retorna o time correspondente; o outro ramo é o destino padrão."],
  ["Cada categoria do resultado precisa ter um destino próprio.", "troque a condição por uma tabela completa.", "cada categoria consulta seu time sugerido.", "Readonly<Record<Category, SuggestedTeam>> exige uma entrada por categoria; a função lê a tabela pela chave category."],
  ["O encaminhamento já tem destino, mas a operação também precisa registrar de onde veio a decisão.", "declare DecisionSource com as duas origens.", "o resultado poderá distinguir regra determinística e LLM.", "O enum DecisionSource dá nomes estáveis a DETERMINISTIC e LLM; ainda não altera a função de encaminhamento."],
  ["Uma decisão que pede revisão deve dizer qual alerta a motivou.", "declare HumanReviewReason com os dois motivos.", "baixa confiança e alta severidade terão nomes explícitos.", "O enum HumanReviewReason define LOW_CONFIDENCE e HIGH_SEVERITY para uso nas próximas decisões."],
  ["O resultado já traz categoria, prioridade, risco e time; agora precisa carregar dados da decisão.", "declare TriageDecision estendendo ClassifierResult.", "a decisão preserva o resultado e inclui revisão, origem e motivos.", "extends mantém os campos de ClassifierResult; os três campos novos descrevem a revisão e sua origem."],
  ["Com o formato definido, o fluxo precisa produzir uma decisão concreta para cada resultado.", "crie decideSingle sem alertas.", "uma resposta comum conserva os dados de entrada e não pede revisão.", "O spread copia os campos de result; a função acrescenta origem, lista vazia e requiresHumanReview falso."],
  ["Uma resposta com confiança 0.5 não deve seguir sem revisão.", "registre LOW_CONFIDENCE e derive o booleano da lista.", "baixa confiança marca a decisão para uma pessoa revisar.", "O if acrescenta LOW_CONFIDENCE quando confidence é 0.5; reviewReasons.length > 0 define requiresHumanReview."],
  ["Prioridade alta ou crítica e risco alto também exigem atenção humana.", "registre HIGH_SEVERITY após o motivo de baixa confiança.", "qualquer uma dessas condições pede revisão, com ordem estável quando ambas ocorrem.", "O segundo if testa HIGH, CRITICAL e risco HIGH; push acrescenta HIGH_SEVERITY depois de LOW_CONFIDENCE."],
] as const;

function versions(plan: StructuredDecisionPlan): string[] {
  const { lookup, result, decision, source, reason, decide, category, team } = plan.names;
  const entry = (name: string) => plan.entries.find((item) => item.category === name)!;
  const first = plan.entries[0]!;
  const initial = `export function ${lookup}(category: ${category}): ${team} {\n  return category === ${category}.${first.category} ? ${team}.${first.team} : ${team}.${entry("OTHER").team};\n}`;
  const map = `const TEAM_BY_CATEGORY: Readonly<Record<${category}, ${team}>> = {\n  ${plan.entries.slice(0, 2).map((item) => `[${category}.${item.category}]: ${team}.${item.team}`).join(", ")},\n  ${plan.entries.slice(2).map((item) => `[${category}.${item.category}]: ${team}.${item.team}`).join(", ")},\n};\nexport function ${lookup}(category: ${category}): ${team} {\n  return TEAM_BY_CATEGORY[category];\n}`;
  const sourceEnum = `export enum ${source} { ${plan.sourceValues.map((value) => `${value} = "${value}"`).join(", ")} }`;
  const reasonEnum = `export enum ${reason} { ${plan.reasonValues.map((value) => `${value} = "${value}"`).join(", ")} }`;
  const shape = `export interface ${decision} extends ${result} {\n  requiresHumanReview: boolean;\n  decisionSource: ${source};\n  reviewReasons: ${reason}[];\n}`;
  const body = (low: boolean, high: boolean) => `export function ${decide}(result: ${result}, origin: ${source}): ${decision} {\n  const reviewReasons: ${reason}[] = [];${low ? `\n  if (result.confidence === 0.5) reviewReasons.push(${reason}.LOW_CONFIDENCE);` : ""}${high ? `\n  if (result.priority === Priority.HIGH || result.priority === Priority.CRITICAL || result.risk === Risk.HIGH) reviewReasons.push(${reason}.HIGH_SEVERITY);` : ""}\n  return { ...result, requiresHumanReview: ${low || high ? "reviewReasons.length > 0" : "false"}, decisionSource: origin, reviewReasons };\n}`;
  const header = `import { ${category}, ${team}, Priority, Risk, type ${result} } from "./triage.ts";`;
  return [
    [header, initial].join("\n"),
    [header, map].join("\n"),
    [header, map, sourceEnum].join("\n"),
    [header, map, sourceEnum, reasonEnum].join("\n"),
    [header, map, sourceEnum, reasonEnum, shape].join("\n"),
    [header, map, sourceEnum, reasonEnum, shape, body(false, false)].join("\n"),
    [header, map, sourceEnum, reasonEnum, shape, body(true, false)].join("\n"),
    [header, map, sourceEnum, reasonEnum, shape, body(true, true)].join("\n"),
  ];
}

function originalReference(plan: StructuredDecisionPlan, symbol: string, index: RepositoryIndex, journey: Journey): OriginalCodeReference {
  const evidence = plan.evidence.find((item) => item.symbol === symbol)!;
  const found = index.declarations.find((item) => item.path === evidence.path && item.symbol === symbol && item.container === evidence.container)!;
  const source = index.files.get(found.path)!;
  return { path: found.path, symbol, startLine: found.startLine, endLine: found.endLine, replayFile: "decision.ts", note: "O Replay conserva a relação e reduz categorias, origens e motivos ao conjunto usado neste percurso.", snippet: source.split("\n").slice(found.startLine - 1, found.endLine).join("\n"), url: `${journey.repo.url}/blob/${journey.repo.sha}/${found.path}#L${found.startLine}-L${found.endLine}` };
}

function architecture(step: number, plan: StructuredDecisionPlan) {
  const nodes = [
    { id: "category", label: plan.names.category, kind: "data" as const, col: 0, row: 0 },
    { id: "team", label: plan.names.team, kind: "data" as const, col: 2, row: 0 },
    ...(step >= 4 ? [{ id: "result", label: plan.names.result, kind: "data" as const, col: 0, row: 1 }] : []),
    ...(step >= 4 ? [{ id: "decision", label: plan.names.decision, kind: "data" as const, col: 2, row: 1 }] : []),
  ];
  const edges = [
    { from: "category", to: "team", rel: "flows_to" as const },
    ...(step >= 4 ? [{ from: "result", to: "decision", rel: "flows_to" as const }] : []),
  ];
  return { nodes, edges };
}

export function generateStructuredDecision(plan: StructuredDecisionPlan, journey: Journey, index: RepositoryIndex): Stage[] {
  const chapter = journey.stages.find((stage) => stage.moduleId === plan.moduleId && stage.kind === "chapter");
  const support = chapter?.referenceCode.find((item) => item.path === "triage.ts");
  if (!chapter || !support) throw new Error("Tipos de resultado indisponíveis no capítulo legado.");
  const code = versions(plan);
  const output: Stage[] = [];
  const previousIds = journey.stages.filter((stage) => stage.order < chapter.order).map((stage) => stage.id);
  for (let i = 0; i <= STEPS.length; i++) {
    const checkpoint = i === STEPS.length;
    const item = STEPS[Math.min(i, STEPS.length - 1)]!;
    const current = code[Math.min(i, code.length - 1)]!;
    const before = i === 0 ? "" : code[i - 1]!;
    const concept = checkpoint ? undefined : item.concept;
    const known = STEPS.slice(0, i).flatMap((step) => step.concept ? [step.concept] : []);
    const ref = originalReference(plan, item.ref, index, journey);
    const test = stageTest(i, plan);
    const id = `${journey.id}.${plan.moduleId}-${checkpoint ? "99" : String(i + 1).padStart(2, "0")}`;
    const [need, task, outcome, codeNote] = DECISION_NARRATIVE[Math.min(i, DECISION_NARRATIVE.length - 1)]!;
    const narrative = stageNarrative({
      previous: i === 0 ? "Até aqui, classificamos tickets e organizamos a chamada ao classificador. O código de apoio deste módulo também descreve prioridade, risco e confiança." : `Na etapa anterior, ${DECISION_NARRATIVE[i - 1]![2]}`,
      need: checkpoint ? "Agora é hora de reunir o encaminhamento e as regras de revisão." : need,
      limitation: i === 0 ? "A categoria e os demais dados ainda não definem sozinhos o encaminhamento." : STEPS[i - 1]!.limitation,
      task: checkpoint ? "reconstrua decision.ts do zero." : task,
      outcome: checkpoint ? "a tabela e a decisão completa voltam a funcionar juntas." : outcome,
      code: checkpoint ? "A solução reúne a tabela, os enums, a interface e decideSingle; compare cada parte com o que praticou." : codeNote,
      detail: `No projeto real, ${item.ref} aparece em ${ref.path}. O Replay usa os valores necessários para praticar esta relação.`,
    });
    output.push(Stage.parse({
      id, order: chapter.order + i, moduleId: plan.moduleId, kind: checkpoint ? "checkpoint" : "micro",
      title: checkpoint ? "Checkpoint: reconstruir a decisão" : item.title,
      goal: checkpoint ? "Reconstruir a tabela e a decisão completa do zero." : item.instruction,
      context: narrative.context,
      problem: narrative.problem,
      examples: [], requirements: checkpoint ? ["Mapeie todas as categorias.", "Guarde a origem.", "Registre baixa confiança e alta severidade em ordem."] : [],
      estimatedMinutes: checkpoint ? 6 : 3, introduces: concept ? [concept] : [], prerequisites: known,
      architecture: architecture(i, plan), referenceCode: [file(current)],
      lineNotes: [{ match: checkpoint ? "reviewReasons.length > 0" : ["return category ===", "return TEAM_BY_CATEGORY", `export enum ${plan.names.source}`, `export enum ${plan.names.reason}`, `export interface ${plan.names.decision}`, "return { ...result", "result.confidence === 0.5", "result.priority === Priority.HIGH"][i]!, note: checkpoint ? "A revisão decorre dos motivos calculados." : item.quick }],
      explanation: [{ id: checkpoint ? "checkpoint" : `step-${i + 1}`, ...(concept ? { conceptId: concept } : {}), title: checkpoint ? "Reconstrua a decisão" : item.title, quick: narrative.quick, normal: narrative.normal }],
      originalCodeRefs: [ref],
      exercise: { instructions: checkpoint ? "Reconstrua decision.ts inteiro: tabela exaustiva, enums, interface e decideSingle com os dois motivos." : item.instruction,
        starterFiles: [{ path: "decision.ts", content: checkpoint || i === 0 ? "" : file(before).content }], solutionFiles: [file(current)], supportFiles: [support], expose: [], testFile: { path: "tests.ts", content: test },
        ...(i === 4 ? { typecheck: { files: [{ path: "check.ts", content: `import type { ${plan.names.decision} } from "./decision.ts";\nimport { ${plan.names.source} } from "./decision.ts";\nconst decision = {} as ${plan.names.decision};\nconst origin: ${plan.names.source} = decision.decisionSource;\nvoid origin;\n` }] } } : {}) },
      toolbox: toolbox(i), tutorContext: { relevantFiles: ["decision.ts", ref.path, support.path], concepts: [...known, ...(concept ? [concept] : [])], previousStages: [...previousIds, ...output.map((stage) => stage.id)] },
      completionCriteria: [{ kind: "tests_pass" }], checkpoint: checkpoint ? { question: "Por que guardar motivos além do booleano de revisão?", answer: "Os motivos explicam a decisão e preservam a ordem estável quando há baixa confiança e alta severidade juntas." } : undefined,
      limitation: checkpoint ? undefined : item.limitation,
      summary: { added: [checkpoint ? "decisão completa" : item.title], why: checkpoint ? "Tornar o encaminhamento e a revisão reproduzíveis." : item.limitation, flow: architecture(i, plan).nodes.map((node) => node.label) },
    }));
  }
  return output;
}

function toolbox(step: number) {
  if (step === 1) return [{ id: "record-lookup", name: "Record como tabela", summary: "Exige uma entrada por chave e permite consulta direta.", example: 'type Color = "red" | "blue"; const labels: Record<Color, string> = { red: "vermelho", blue: "azul" };', whenToUse: "Quando cada categoria precisa de um destino obrigatório." }];
  if (step === 4) return [{ id: "extends", name: "interface extends", summary: "Acrescenta campos mantendo o formato anterior.", example: "interface Result { ok: boolean } interface Decision extends Result { reviewed: boolean }" }];
  if (step === 5) return [{ id: "spread", name: "Spread em objeto", summary: "Copia campos para um novo objeto.", example: "const result = { ok: true }; const decision = { ...result, reviewed: false };" }];
  if (step === 6 || step === 7) return [{ id: "array-push", name: "Array.push", summary: "Acrescenta um motivo no fim, preservando a ordem.", example: 'const reasons: string[] = []; reasons.push("LOW_CONFIDENCE");' }];
  return [];
}

function stageTest(step: number, plan: StructuredDecisionPlan): string {
  const { lookup, decide, source, reason, category, team } = plan.names;
  const initial = plan.entries[0]!;
  const base = `const base = { category: ${category}.${initial.category}, priority: Priority.LOW, risk: Risk.LOW, suggestedTeam: ${team}.${initial.team}, confidence: 0.9 as const, summary: "ticket", rationale: "regra" };`;
  const imports = `import { test, expect } from "ownr:test";\nimport { ${category}, ${team}, Priority, Risk } from "./triage.ts";\nimport { ${lookup}${step >= 2 ? `, ${source}` : ""}${step >= 3 ? `, ${reason}` : ""}${step >= 5 ? `, ${decide}` : ""} } from "./decision.ts";\n`;
  const checks = [
    `test("primeiro destino", () => expect(${lookup}(${category}.${initial.category})).toBe(${team}.${initial.team}));`,
    `test("tabela completa", () => { ${plan.entries.map((item) => `expect(${lookup}(${category}.${item.category})).toBe(${team}.${item.team});`).join(" ")} });`,
    `test("origem explícita", () => { expect(${source}.DETERMINISTIC).toBe("DETERMINISTIC"); expect(${source}.LLM).toBe("LLM"); });`,
    `test("motivos explícitos", () => { expect(${reason}.LOW_CONFIDENCE).toBe("LOW_CONFIDENCE"); expect(${reason}.HIGH_SEVERITY).toBe("HIGH_SEVERITY"); });`,
    `test("formato preservado", () => expect(${source}.DETERMINISTIC).toBe("DETERMINISTIC"));`,
    `test("decisão sem alerta", () => { const input = { ...base }; expect(${decide}(input, ${source}.DETERMINISTIC)).toEqual({ ...input, requiresHumanReview: false, decisionSource: ${source}.DETERMINISTIC, reviewReasons: [] }); expect(input).toEqual(base); });`,
    `test("baixa confiança", () => { const result = ${decide}({ ...base, confidence: 0.5 }, ${source}.LLM); expect(result.reviewReasons).toEqual([${reason}.LOW_CONFIDENCE]); expect(result.requiresHumanReview).toBe(true); });`,
    `test("alta severidade e ordem", () => { for (const change of [{ priority: Priority.HIGH }, { priority: Priority.CRITICAL }, { risk: Risk.HIGH }]) expect(${decide}({ ...base, ...change }, ${source}.DETERMINISTIC).reviewReasons).toEqual([${reason}.HIGH_SEVERITY]); expect(${decide}({ ...base, confidence: 0.5, risk: Risk.HIGH }, ${source}.LLM).reviewReasons).toEqual([${reason}.LOW_CONFIDENCE, ${reason}.HIGH_SEVERITY]); });`,
  ];
  return imports + (step >= 5 ? base + "\n" : "") + checks[Math.min(step, checks.length - 1)]!;
}
