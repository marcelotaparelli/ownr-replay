import type { Journey } from "../domain/journey.ts";
import { Stage, type OriginalCodeReference } from "../domain/stage.ts";
import type { RepositoryIndex } from "./code-map.ts";
import { stageNarrative } from "./stage-narrative.ts";

/** A bounded pattern: an HTTP classifier behind a port, with validated structured output. */
export type RemoteClassifierPlan = {
  kind: "remote-classifier";
  moduleId: string;
  goal: string;
  className: string;
  parserName: string;
  endpoint: string;
  symbols: { adapter: string; schema: string; fetch: string; error: string };
  evidence: { path: string; symbol: string }[];
};

export function planRemoteClassifier(goal: string, _journey: Journey, moduleId: string, chapter: Stage, index: RepositoryIndex): RemoteClassifierPlan {
  const adapter = chapter.referenceCode.find((file) => /class \w+ implements TriageClassifier/.test(file.content) && /fetchImpl/.test(file.content));
  const schema = chapter.referenceCode.find((file) => /export function parse\w+Result\(/.test(file.content));
  const errors = chapter.referenceCode.find((file) => /class ClassifierTimeoutError/.test(file.content));
  const className = /class (\w+) implements TriageClassifier/.exec(adapter?.content ?? "")?.[1];
  const parserName = /export function (parse\w+Result)\(/.exec(schema?.content ?? "")?.[1];
  const endpoint = /baseUrl \+ "([^"]+)"/.exec(adapter?.content ?? "")?.[1];
  const ref = chapter.originalCodeRefs.find((item) => index.declarations.some((decl) => decl.path === item.path && decl.symbol === item.symbol && /TriageClassifier$/.test(item.symbol) && /class\s+/.test(index.files.get(item.path) ?? "")));
  const schemaRef = chapter.originalCodeRefs.find((item) => /Schema$/.test(item.symbol) && /strictObject/.test(index.files.get(item.path) ?? ""));
  const fetchRef = chapter.originalCodeRefs.find((item) => item.symbol === "HttpFetch");
  const errorRef = chapter.originalCodeRefs.find((item) => item.symbol === "ClassifierTimeoutError");
  const target = goal.trim().toLowerCase();
  const accepted = [className, ref?.symbol, adapter?.path, ref?.path, "classificador llm", "llm", "ollama"].filter(Boolean).some((name) => name!.toLowerCase() === target);
  if (!accepted) throw new Error("Objetivo específico não corresponde ao classificador remoto deste capítulo.");
  if (!adapter || !schema || !errors || !className || !parserName || !endpoint || !ref || !schemaRef || !fetchRef || !errorRef ||
      !/implements TriageClassifier/.test(adapter.content) || !/AbortController/.test(adapter.content) || !/signal: controller.signal/.test(adapter.content) ||
      !adapter.content.includes(`${parserName}(await readContent(response))`) || !/suggestedTeamForCategory\(result.category\)/.test(adapter.content) ||
      !/Object.keys\(v\).some/.test(schema.content) || !/ClassifierInvalidResponseError/.test(errors.content)) {
    throw new Error("Estrutura de adapter HTTP, cancelamento e validação ainda não suportada neste capítulo.");
  }
  const evidence = [ref, schemaRef, fetchRef, errorRef].map(({ path, symbol }) => ({ path, symbol }));
  for (const item of evidence) if (!index.declarations.some((decl) => decl.path === item.path && decl.symbol === item.symbol)) {
    throw new Error(`Declaração ${item.symbol} ausente no SHA fixado.`);
  }
  const realAdapter = index.files.get(ref.path) ?? "";
  const realSchema = index.files.get(schemaRef.path) ?? "";
  if (!/implements TriageClassifier/.test(realAdapter) || !/AbortController/.test(realAdapter) || !/fetchImpl/.test(realAdapter) ||
      !realAdapter.includes(schemaRef.symbol) || !/strictObject/.test(realSchema)) {
    throw new Error("As relações do adapter e do schema não foram confirmadas no código real.");
  }
  return { kind: "remote-classifier", moduleId, goal, className, parserName, endpoint,
    symbols: { adapter: ref.symbol, schema: schemaRef.symbol, fetch: fetchRef.symbol, error: errorRef.symbol }, evidence };
}

const STEPS = [
  ["Enviar uma requisição", "Uma chamada HTTP permite consultar o classificador externo.", "A requisição ainda não leva o ticket.", "Envie POST ao serviço usando fetch injetado.", "return fetchImpl", "fetch"],
  ["Enviar o ticket", "O corpo leva o título e a descrição do ticket.", "Uma resposta HTTP com falha ainda parece sucesso.", "Inclua o ticket no corpo JSON.", "body: JSON.stringify", "fetch"],
  ["Verificar o status", "O status HTTP interrompe uma resposta indisponível.", "O corpo ainda é um envelope, não uma decisão.", "Rejeite respostas HTTP sem ok.", "if (!response.ok)", "adapter"],
  ["Ler o envelope", "A resposta contém texto JSON dentro de message.content.", "O texto pode conter valores inventados.", "Leia o conteúdo do envelope e converta seu JSON.", "JSON.parse", "adapter"],
  ["Validar os campos", "O parser recusa campos extras e valores fora do domínio.", "O time ainda não foi derivado da categoria.", "Valide o conteúdo antes de devolvê-lo.", "parseLlmResult", "schema"],
  ["Derivar o time", "A tabela local escolhe o time pela categoria validada.", "Falta oferecer o contrato que a aplicação usa.", "Complete o resultado com suggestedTeam local.", "suggestedTeamForCategory", "adapter"],
  ["Cumprir a porta", "O adapter agora pode ser usado pelo mesmo caso de uso.", "Falhas de rede ainda perdem sua identidade.", "Crie a classe que implementa TriageClassifier.", "implements TriageClassifier", "adapter"],
  ["Nomear a indisponibilidade", "Uma falha de conexão vira erro reconhecível.", "Um envelope inválido ainda vira erro genérico.", "Traduza falhas de fetch e status para ClassifierUnavailableError.", "ClassifierUnavailableError", "error"],
  ["Nomear a resposta inválida", "JSON quebrado ou campos errados viram erro próprio.", "Uma requisição lenta ainda pode ficar pendurada.", "Traduza o conteúdo inválido para ClassifierInvalidResponseError.", "ClassifierInvalidResponseError", "schema"],
  ["Cancelar a espera", "O timer cancela o fetch e é limpo ao terminar.", "Agora reúna o fluxo sem o ponto de partida.", "Use AbortController, signal e finally para distinguir timeout.", "controller.abort()", "adapter"],
] as const;

function code(plan: RemoteClassifierPlan, step: number): string {
  const lines: string[] = [];
  if (step >= 4) lines.push(`import { ${plan.parserName} } from "./llm-result.ts";`);
  if (step >= 5) lines.push('import { suggestedTeamForCategory } from "./suggested-team.ts";');
  if (step >= 6) lines.push('import type { TriageClassifier } from "./triage-classifier.ts";', 'import type { TicketInput, ClassifierResult } from "./triage.ts";');
  if (step >= 7) lines.push('import { ClassifierUnavailableError, ClassifierInvalidResponseError, ClassifierTimeoutError } from "./classifier-errors.ts";');
  const args = step === 0 ? 'url: string, fetchImpl: typeof fetch' : step >= 9 ? 'url: string, input: TicketInput, fetchImpl: typeof fetch, timeoutMs: number = 1000' : step >= 6 ? 'url: string, input: TicketInput, fetchImpl: typeof fetch' : 'url: string, input: { title: string; description: string }, fetchImpl: typeof fetch';
  const output = step < 3 ? 'Response' : step < 4 ? 'unknown' : step < 5 ? 'unknown' : step >= 6 ? 'ClassifierResult' : 'object';
  lines.push(`export async function requestClassifier(${args}): Promise<${output}> {`);
  if (step >= 9) lines.push('  const controller = new AbortController();', '  const timer = setTimeout(() => controller.abort(), timeoutMs);', '  try {');
  const indent = step >= 9 ? '    ' : '  ';
  const fetchCall = `fetchImpl(url + "${plan.endpoint}", { method: "POST"${step >= 1 ? ', headers: { "content-type": "application/json" }, body: JSON.stringify(input)' : ''}${step >= 9 ? ', signal: controller.signal' : ''} })`;
  if (step >= 7) lines.push(`${indent}let response: Response;`, `${indent}try { response = await ${fetchCall}; } catch { throw ${step >= 9 ? 'controller.signal.aborted ? new ClassifierTimeoutError() : ' : ''}new ClassifierUnavailableError(); }`);
  else if (step >= 2) lines.push(`${indent}const response = await ${fetchCall};`);
  else lines.push(`${indent}return ${fetchCall};`);
  if (step >= 2) lines.push(`${indent}if (!response.ok) throw ${step >= 7 ? 'new ClassifierUnavailableError()' : 'new Error("HTTP indisponível")'};`);
  if (step === 2) lines.push(`${indent}return response;`);
  if (step >= 3) {
    if (step >= 8) lines.push(`${indent}let value: unknown;`, `${indent}try { const envelope = await response.json(); value = JSON.parse(envelope.message.content); } catch { throw new ClassifierInvalidResponseError(); }`);
    else lines.push(`${indent}const envelope = await response.json();`, `${indent}const value = JSON.parse(envelope.message.content);`);
    if (step === 3) lines.push(`${indent}return value;`);
  }
  if (step >= 4) lines.push(`${indent}const result = ${plan.parserName}(value);`, `${indent}if (!result) throw ${step >= 8 ? 'new ClassifierInvalidResponseError()' : 'new Error("Resposta inválida")'};`, `${indent}return ${step >= 5 ? '{ ...result, suggestedTeam: suggestedTeamForCategory(result.category) }' : 'result'};`);
  if (step >= 9) lines.push('  } finally { clearTimeout(timer); }');
  lines.push('}');
  if (step >= 6) lines.push(`export class ${plan.className} implements TriageClassifier {`, '  constructor(private readonly url: string, private readonly fetchImpl: typeof fetch, private readonly timeoutMs = 1000) {}', `  classify(input: TicketInput): Promise<ClassifierResult> { return requestClassifier(this.url, input, this.fetchImpl${step >= 9 ? ', this.timeoutMs' : ''}); }`, '}');
  return lines.join('\n') + '\n';
}

function ref(plan: RemoteClassifierPlan, symbol: string, index: RepositoryIndex, journey: Journey): OriginalCodeReference {
  const item = plan.evidence.find((entry) => entry.symbol === symbol)!;
  const decl = index.declarations.find((entry) => entry.path === item.path && entry.symbol === item.symbol)!;
  const source = index.files.get(item.path)!;
  return { path: item.path, symbol, startLine: decl.startLine, endLine: decl.endLine, replayFile: 'remote.ts',
    ...(symbol === plan.symbols.adapter ? { replaySymbol: plan.className } : {}),
    note: 'O Replay reduz o protocolo HTTP ao fluxo necessário para estudar a porta, as falhas e a validação. O projeto usa Ollama local e schema Zod.',
    snippet: source.split('\n').slice(decl.startLine - 1, decl.endLine).join('\n'),
    url: `${journey.repo.url}/blob/${journey.repo.sha}/${item.path}#L${decl.startLine}-L${decl.endLine}` };
}

function stageTest(step: number, plan: RemoteClassifierPlan): string {
  const imports = 'import { test, expect } from "ownr:test";\nimport { Category, SuggestedTeam, Priority, Risk } from "./triage.ts";\nimport { requestClassifier' + (step >= 6 ? `, ${plan.className}` : '') + ' } from "./remote.ts";\nimport { ClassifierUnavailableError, ClassifierInvalidResponseError, ClassifierTimeoutError } from "./classifier-errors.ts";\n';
  const sample = 'const input = { title: "site down", description: "all users" };\nconst valid = { category: Category.INCIDENT, priority: Priority.LOW, risk: Risk.LOW, confidence: 0.9, summary: "site", rationale: "down" };\nconst reply = () => new Response(JSON.stringify({ message: { content: JSON.stringify(valid) } }));\n';
  const tests = [
    'test("envia POST", async () => { let method = ""; await requestClassifier("http://local", async (_url, init) => { method = init?.method ?? ""; return reply(); }); expect(method).toBe("POST"); });',
    'test("envia o ticket", async () => { let body = ""; await requestClassifier("http://local", input, async (_url, init) => { body = String(init?.body); return reply(); }); expect(JSON.parse(body)).toEqual(input); });',
    'test("rejeita status ruim", async () => { let failed = false; try { await requestClassifier("http://local", input, async () => new Response("", { status: 503 })); } catch { failed = true; } expect(failed).toBe(true); });',
    'test("lê o envelope", async () => expect(await requestClassifier("http://local", input, async () => reply())).toEqual(valid));',
    'test("rejeita categoria inventada", async () => { let failed = false; try { await requestClassifier("http://local", input, async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ ...valid, category: "INVENTED" }) } }))); } catch { failed = true; } expect(failed).toBe(true); });',
    'test("deriva o time localmente", async () => expect(await requestClassifier("http://local", input, async () => reply())).toEqual({ ...valid, suggestedTeam: SuggestedTeam.INFRASTRUCTURE }));',
    `test("cumpre a porta", async () => expect(await new ${plan.className}("http://local", async () => reply()).classify(input)).toEqual({ ...valid, suggestedTeam: SuggestedTeam.INFRASTRUCTURE }));`,
    'test("rede indisponível tem tipo", async () => { let error: unknown; try { await requestClassifier("http://local", input, async () => { throw new Error("offline"); }); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(ClassifierUnavailableError); });',
    'test("corpo inválido tem tipo", async () => { let error: unknown; try { await requestClassifier("http://local", input, async () => new Response("bad")); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(ClassifierInvalidResponseError); });',
    'test("timeout cancela e limpa", async () => { let signal: AbortSignal | undefined; let error: unknown; try { await requestClassifier("http://local", input, async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))); }, 1); } catch (caught) { error = caught; } expect(signal?.aborted).toBe(true); expect(error).toBeInstanceOf(ClassifierTimeoutError); });',
  ];
  return imports + sample + (step === 10 ? [2, 4, 5, 6, 7, 8, 9].map((index) => tests[index]).join('\n') : tests[step]!);
}

export function generateRemoteClassifier(plan: RemoteClassifierPlan, journey: Journey, index: RepositoryIndex): Stage[] {
  const chapter = journey.stages.find((stage) => stage.moduleId === plan.moduleId && stage.kind === 'chapter');
  if (!chapter) throw new Error('Capítulo legado indisponível.');
  const support = chapter.exercise?.supportFiles ?? [];
  const earlier = journey.stages.filter((stage) => stage.order < chapter.order).map((stage) => stage.id);
  const concepts = [undefined, 'injected-fetch', undefined, undefined, 'structured-output', undefined, 'adapter', 'typed-errors', undefined, 'abort-timeout'] as const;
  const contextFiles = ['triage.ts', 'triage.ts', 'triage.ts', 'triage.ts', 'llm-result.ts', 'suggested-team.ts', 'triage-classifier.ts', 'classifier-errors.ts', 'classifier-errors.ts', 'classifier-errors.ts'];
  const output: Stage[] = [];
  for (let i = 0; i <= STEPS.length; i++) {
    const checkpoint = i === STEPS.length;
    const item = STEPS[Math.min(i, STEPS.length - 1)]!;
    const current = code(plan, Math.min(i, STEPS.length - 1));
    const before = i === 0 ? '' : code(plan, i - 1);
    const concept = checkpoint ? undefined : concepts[i];
    const known = [...new Set(output.flatMap((stage) => stage.introduces))];
    const symbol = checkpoint ? plan.symbols.adapter : plan.symbols[item[5]];
    const reference = ref(plan, symbol, index, journey);
    const narrative = stageNarrative({ previous: i === 0 ? 'Até aqui, um contrato classifica tickets sem depender de uma tecnologia específica.' : `Na etapa anterior, ${STEPS[i - 1]![1]}`,
      need: checkpoint ? 'Agora o adapter está completo e pode ser reconstruído.' : 'Uma nova necessidade aparece no fluxo de triagem.',
      limitation: i === 0 ? 'O contrato ainda não consulta um serviço externo.' : STEPS[i - 1]![2],
      task: checkpoint ? 'reconstrua o adapter do zero.' : item[3], outcome: checkpoint ? 'o fluxo completo volta a funcionar.' : item[1],
      code: checkpoint ? 'Reúna requisição, validação, erros e cancelamento no mesmo fluxo.' : `${item[1]} A linha ${item[4]} torna essa mudança visível no código.`,
      detail: `No projeto real, ${symbol} aparece em ${reference.path}. O Replay usa uma versão menor do mesmo fluxo.` });
    output.push(Stage.parse({ id: `${journey.id}.${plan.moduleId}-${checkpoint ? '99' : String(i + 1).padStart(2, '0')}`, order: chapter.order + i,
      moduleId: plan.moduleId, kind: checkpoint ? 'checkpoint' : 'micro', title: checkpoint ? 'Checkpoint: reconstruir o adapter remoto' : item[0],
      goal: checkpoint ? 'Reconstruir o classificador remoto completo.' : item[3], context: narrative.context, problem: narrative.problem, examples: [],
      requirements: checkpoint ? ['Envie o ticket.', 'Valide a saída.', 'Distinga indisponibilidade, resposta inválida e timeout.'] : [],
      estimatedMinutes: checkpoint ? 6 : 3, introduces: concept ? [concept] : [], prerequisites: known,
      ...(i === 6 || i === 9 ? { noveltyException: 'O contrato da classe e o cancelamento exigem poucas linhas adicionais que formam uma única ideia.' } : {}),
      referenceCode: [{ path: 'remote.ts', content: current }], lineNotes: [{ match: i === 4 ? plan.parserName : item[4], note: narrative.quick }],
      explanation: [{ id: checkpoint ? 'checkpoint' : `remote-${i + 1}`, ...(concept ? { conceptId: concept } : {}), title: checkpoint ? 'Reconstrua o adapter' : item[0], quick: narrative.quick, normal: narrative.normal }],
      originalCodeRefs: [reference],
      exercise: { instructions: checkpoint ? 'Reconstrua remote.ts completo: requisição, contrato, validação, erros tipados e timeout.' : item[3],
        starterFiles: [{ path: 'remote.ts', content: checkpoint ? '' : before }], solutionFiles: [{ path: 'remote.ts', content: current }], supportFiles: support,
        expose: [], testFile: { path: 'tests.ts', content: stageTest(i, plan) } },
      toolbox: i === 0 ? [{ id: 'fetch', name: 'fetch', summary: 'Envia uma requisição HTTP.', example: 'async function send(url: string) { return fetch(url, { method: "POST" }); }' }] :
        i === 4 ? [{ id: 'parse', name: 'Validação de dados externos', summary: 'Confira cada campo antes de usar uma resposta externa.', example: 'function required(value: unknown) { if (value === undefined) throw new Error("inválido"); return value; }' }] :
        i === 9 ? [{ id: 'abort-controller', name: 'AbortController', summary: 'Cancela uma operação pelo signal.', example: 'const controller = new AbortController(); controller.abort();' }] : [],
      tutorContext: { relevantFiles: ['remote.ts', reference.path, contextFiles[Math.min(i, 9)]!], concepts: [...known, ...(concept ? [concept] : [])], previousStages: [...earlier, ...output.map((stage) => stage.id)] },
      completionCriteria: [{ kind: 'tests_pass' }], checkpoint: checkpoint ? { question: 'Por que validar a resposta depois de solicitar JSON ao modelo?', answer: 'O formato pedido ao modelo é apenas uma instrução; a validação impede que dados inventados ou malformados entrem no domínio.' } : undefined,
      limitation: checkpoint ? undefined : item[2], summary: { added: [checkpoint ? 'classificador remoto completo' : item[0]], why: checkpoint ? 'Manter o contrato previsível com uma dependência externa.' : item[2], flow: ['TicketInput', plan.className, 'ClassifierResult'] },
    }));
  }
  return output;
}
