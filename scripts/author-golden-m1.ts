// Authoring source of Module 1 (micro stages + checkpoint) of the ops-triage-ai golden journey.
// Regenerates data/golden/ops-triage-ai/stages/m1: edit here, run `bun scripts/author-golden-m1.ts`, then `bun test`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../data/golden/ops-triage-ai/stages/m1");
rmSync(ROOT, { recursive: true, force: true });

type Node = { id: string; label: string; kind: string; col: number; row: number };
type Edge = { from: string; to: string; rel: string };
type Tool = { id: string; name: string; signature?: string; summary: string; example: string; whenToUse?: string };
type Micro = {
  slug: string;
  kind?: "micro" | "checkpoint";
  title: string;
  subtitle?: string;
  goal: string;
  problem: string;
  example?: string;
  minutes: number;
  introduces: string[];
  prerequisites: string[];
  arch: { nodes: Node[]; edges: Edge[] };
  /** Files shown as the solution (pedagogical versions). First one is the new piece. */
  reference: Record<string, string>;
  lineNotes: { match: string; note: string }[];
  explanation: { id: string; conceptId?: string; title: string; quick: string; normal?: string; deep?: string }[];
  exercise: { instructions: string; files: string[]; expose: string[]; support?: string[]; solution?: Record<string, string> };
  /** Valid modules the exercise builds on (with import/export), keyed by file name. */
  given?: Record<string, string>;
  tests: string;
  toolbox: Tool[];
  limitation?: string;
  originalCodeRefs?: unknown[];
  checkpoint?: { question: string; answer: string };
};

// ---------- shared code fragments ----------
const TICKET = "ticket: { title: string; description: string }";
const RULES_V1 = `const RULES = [
  { word: "down", category: "INCIDENT" },
  { word: "outage", category: "INCIDENT" },
  { word: "bug", category: "BUG" },
  { word: "error", category: "BUG" },
  { word: "login", category: "ACCESS" },
  { word: "password", category: "ACCESS" },
];`;
const RULES_WEIGHTED = `const RULES = [
  { word: "down", category: "INCIDENT", weight: 5 },
  { word: "outage", category: "INCIDENT", weight: 4 },
  { word: "bug", category: "BUG", weight: 3 },
  { word: "error", category: "BUG", weight: 1 },
  { word: "login", category: "ACCESS", weight: 4 },
  { word: "password", category: "ACCESS", weight: 2 },
];`;
const RULES_REGEX = String.raw`const RULES = [
  { pattern: /\bdown\b/, category: "INCIDENT", weight: 5 },
  { pattern: /\boutage\b/, category: "INCIDENT", weight: 4 },
  { pattern: /\bbug\b/, category: "BUG", weight: 3 },
  { pattern: /\berror\b/, category: "BUG", weight: 1 },
  { pattern: /\blogin\b/, category: "ACCESS", weight: 4 },
  { pattern: /\bpassword\b/, category: "ACCESS", weight: 2 },
];`;
const RULES_ENUM = String.raw`const RULES = [
  { pattern: /\bdown\b/, category: Category.INCIDENT, weight: 5 },
  { pattern: /\boutage\b/, category: Category.INCIDENT, weight: 4 },
  { pattern: /\bbug\b/, category: Category.BUG, weight: 3 },
  { pattern: /\berror\b/, category: Category.BUG, weight: 1 },
  { pattern: /\blogin\b/, category: Category.ACCESS, weight: 4 },
  { pattern: /\bpassword\b/, category: Category.ACCESS, weight: 2 },
];`;
const SCORE_COUNT = `function scoreCategory(category: string, text: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && text.includes(rule.word)) score += 1;
  }
  return score;
}`;
const SCORE_TITLE = `function scoreCategory(category: string, title: string, description: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && title.includes(rule.word)) score += 2;
    if (rule.category === category && description.includes(rule.word)) score += 1;
  }
  return score;
}`;
const SCORE_WEIGHTED = `function scoreCategory(category: string, title: string, description: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && title.includes(rule.word)) score += rule.weight * 2;
    if (rule.category === category && description.includes(rule.word)) score += rule.weight;
  }
  return score;
}`;
const SCORE_REGEX = `function scoreCategory(category: string, title: string, description: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && rule.pattern.test(title)) score += rule.weight * 2;
    if (rule.category === category && rule.pattern.test(description)) score += rule.weight;
  }
  return score;
}`;
const CLASSIFY_PICK = `const CATEGORIES = ["INCIDENT", "BUG", "ACCESS"];

function classify(${TICKET}): string {
  const text = (ticket.title + " " + ticket.description).toLowerCase();
  let best = "OTHER";
  let bestScore = 0;
  for (const category of CATEGORIES) {
    const score = scoreCategory(category, text);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}`;
const CLASSIFY_SPLIT = `const CATEGORIES = ["INCIDENT", "BUG", "ACCESS"];

function classify(${TICKET}): string {
  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();
  let best = "OTHER";
  let bestScore = 0;
  for (const category of CATEGORIES) {
    const score = scoreCategory(category, title, description);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}`;
const CLASSIFY_TIE = `// Em empate vence quem vem primeiro: ignorar um incidente é o erro mais caro.
const TIE_BREAK = ["INCIDENT", "ACCESS", "BUG"];

function classify(${TICKET}): string {
  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();
  let best = "OTHER";
  let bestScore = 0;
  for (const category of TIE_BREAK) {
    const score = scoreCategory(category, title, description);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}`;
const CATEGORY_ENUM = `enum Category {
  INCIDENT = "INCIDENT",
  BUG = "BUG",
  ACCESS = "ACCESS",
  OTHER = "OTHER",
}`;
const CLASSIFY_ENUM = `const TIE_BREAK = [Category.INCIDENT, Category.ACCESS, Category.BUG];

function classify(${TICKET}): Category {
  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();
  let best = Category.OTHER;
  let bestScore = 0;
  for (const category of TIE_BREAK) {
    const score = scoreCategory(category, title, description);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}`;

const exp = (code: string) => code.replace(/^(const|function|enum) /gm, "export $1 ");
const imp = (names: string, from: string) => `import { ${names} } from "./${from}";\n\n`;
const T = (body: string, from: string, names: string) => `import { test, expect } from "replay:test";\nimport { ${names} } from "./${from}";\n\n${body.trim()}\n`;

// ---------- architecture snapshots (only what has been learned) ----------
const n = (id: string, label: string, kind: string, col: number, row = 0): Node => ({ id, label, kind, col, row });
const e = (from: string, to: string, rel = "flows_to"): Edge => ({ from, to, rel });
const ARCH_TEXT = { nodes: [n("text", "texto", "data", 0), n("classify", "classify()", "function", 1), n("category", "categoria", "data", 2)], edges: [e("text", "classify"), e("classify", "category", "creates")] };
const ARCH_TICKET = { nodes: [n("ticket", "ticket", "data", 0), n("classify", "classify()", "function", 1), n("category", "categoria", "data", 2)], edges: [e("ticket", "classify"), e("classify", "category", "creates")] };
const ARCH_RULES = { nodes: [...ARCH_TICKET.nodes, n("rules", "RULES", "data", 1, 1)], edges: [...ARCH_TICKET.edges, e("classify", "rules", "reads")] };
const ARCH_SCORE = { nodes: [n("rules", "RULES", "data", 0), n("score", "scoreCategory()", "function", 1)], edges: [e("score", "rules", "reads")] };
const ARCH_PICK = { nodes: [n("ticket", "ticket", "data", 0), n("classify", "classify()", "function", 1), n("category", "categoria", "data", 2), n("score", "scoreCategory()", "function", 1, 1), n("rules", "RULES", "data", 2, 1)], edges: [e("ticket", "classify"), e("classify", "category", "creates"), e("classify", "score", "calls"), e("score", "rules", "reads")] };
const ARCH_TIE = { nodes: [...ARCH_PICK.nodes, n("tie", "TIE_BREAK", "data", 0, 1)], edges: [...ARCH_PICK.edges, e("classify", "tie", "reads")] };
const ARCH_ENUM = { nodes: [...ARCH_TIE.nodes.map((x) => (x.id === "category" ? { ...x, label: "Category", kind: "data" } : x))], edges: ARCH_TIE.edges };

// ---------- toolbox ----------
const tool = {
  fn: { id: "function", name: "function", signature: "function nome(param) { ... }", summary: "Declara uma função: recebe parâmetros, devolve um valor com return.", example: "function double(n: number): number {\n  return n * 2;\n}" },
  ret: { id: "return", name: "return", summary: "Encerra a função e devolve o valor.", example: 'return "pronto";' },
  includes: { id: "includes", name: "String.includes()", signature: "texto.includes(pedaço): boolean", summary: "true se o texto contém o pedaço.", example: '"server down".includes("down"); // true' },
  if: { id: "if", name: "if", summary: "Executa algo só quando a condição é verdadeira.", example: 'if (idade >= 18) return "adulto";\nreturn "menor";' },
  lower: { id: "to-lower", name: "String.toLowerCase()", summary: "Cópia do texto em minúsculas.", example: '"Server DOWN".toLowerCase(); // "server down"' },
  object: { id: "object-param", name: "Objeto como parâmetro", summary: "Um valor com campos nomeados; leia com ponto.", example: 'function greet(user: { name: string }) {\n  return "oi " + user.name;\n}' },
  concat: { id: "concat", name: "Juntar textos (+)", summary: "+ entre strings concatena.", example: '"a" + " " + "b"; // "a b"' },
  array: { id: "array-objects", name: "Array de objetos", summary: "Uma lista de itens com o mesmo formato.", example: 'const fruits = [\n  { name: "maçã", color: "red" },\n  { name: "banana", color: "yellow" },\n];' },
  forOf: { id: "for-of", name: "for...of", signature: "for (const item of lista) { ... }", summary: "Percorre os itens de uma lista, em ordem.", example: 'for (const fruit of fruits) {\n  if (fruit.color === "red") return fruit.name;\n}' },
  counter: { id: "counter", name: "Contador (+=)", summary: "Comece em 0 e some dentro do laço.", example: "let total = 0;\nfor (const n of [1, 2, 3]) total += n;\n// total === 6" },
  and: { id: "and", name: "&& (e)", summary: "Verdadeiro só se os dois lados forem.", example: 'if (fruit.color === "red" && fruit.ripe) eat(fruit);' },
  max: { id: "running-max", name: "Guardar o maior até agora", summary: "Duas variáveis: o melhor item e seu valor; troque quando achar um maior.", example: 'let best = "";\nlet bestValue = 0;\nfor (const p of players) {\n  if (p.points > bestValue) {\n    best = p.name;\n    bestValue = p.points;\n  }\n}' },
  regex: { id: "regex-test", name: "RegExp.test()", signature: "/padrão/.test(texto): boolean", summary: "true se o padrão casa em algum lugar do texto.", example: '/cat/.test("concatenate"); // true' },
  boundary: { id: "word-boundary", name: String.raw`\b (fronteira de palavra)`, summary: "Casa onde uma palavra começa ou termina.", example: String.raw`/\bcat\b/.test("concatenate"); // false` + "\n" + String.raw`/\bcat\b/.test("my cat");      // true` },
  enumT: { id: "enum", name: "enum", signature: 'enum Nome { A = "A", B = "B" }', summary: "Um conjunto fechado de valores com nome.", example: 'enum Color { RED = "RED", BLUE = "BLUE" }\nColor.RED; // "RED"' },
} satisfies Record<string, Tool>;

// ---------- the micro stages ----------
const stages: Micro[] = [
  {
    slug: "01-fixed-answer",
    title: "Uma resposta fixa",
    subtitle: "Entra um texto, sai uma categoria",
    goal: "Ter uma função que recebe o texto de um ticket e devolve uma categoria.",
    problem: 'Queremos classificar o ticket **"production down"** como **INCIDENT**.\n\nQual é o programa mais simples possível que faz isso?',
    example: 'classify("production down")\n→ "INCIDENT"',
    minutes: 1,
    introduces: ["function-io"],
    prerequisites: [],
    arch: ARCH_TEXT,
    reference: { "classify.ts": `function classify(text: string): string {\n  return "INCIDENT";\n}` },
    lineNotes: [
      { match: "function classify", note: "Declara a função classify. `text` é o que entra; o `: string` depois dos parênteses diz que sai um texto." },
      { match: 'return "INCIDENT"', note: "Sempre a mesma resposta. A função ainda nem olha o texto — de propósito." },
    ],
    explanation: [
      {
        id: "io",
        conceptId: "function-io",
        title: "Entra texto, sai categoria",
        quick: "Uma função é uma caixa: entra o texto do ticket, sai uma categoria. Esta devolve sempre `\"INCIDENT\"`.",
        normal: "`text: string` e `: string` são anotações do TypeScript: dizem o que entra e o que sai. Sem elas, é JavaScript puro — e funcionaria igual.",
      },
    ],
    exercise: { instructions: 'Crie uma função `classify` que recebe um texto e devolve `"INCIDENT"`.', files: ["classify.ts"], expose: ["classify"] },
    tests: T(`test('classify("production down") → "INCIDENT"', () => {\n  expect(classify("production down")).toBe("INCIDENT");\n});`, "classify.ts", "classify"),
    toolbox: [tool.fn, tool.ret],
    limitation: 'Mas agora **"lunch menu"** também vira INCIDENT.',
  },
  {
    slug: "02-look-at-text",
    title: "Olhar o texto",
    subtitle: "Uma palavra decide",
    goal: "Decidir a categoria a partir de uma palavra do texto.",
    problem: '"lunch menu" não é um incidente, mas a função diz que é.\n\nComo decidir **olhando o texto**?',
    example: 'classify("production down") → "INCIDENT"\nclassify("lunch menu")      → "OTHER"',
    minutes: 1,
    introduces: ["keyword-match", "default-category"],
    prerequisites: ["function-io"],
    arch: ARCH_TEXT,
    reference: { "classify.ts": `function classify(text: string): string {\n  if (text.includes("down")) return "INCIDENT";\n  return "OTHER";\n}` },
    lineNotes: [
      { match: 'text.includes("down")', note: '`includes` responde true/false: o texto contém "down"? Se sim, devolvemos INCIDENT e a função termina ali.' },
      { match: 'return "OTHER"', note: "Se nenhuma condição acima devolveu nada, cai aqui: a resposta padrão." },
    ],
    explanation: [
      { id: "word", conceptId: "keyword-match", title: "Uma pista no texto", quick: 'Se o texto contém "down", é INCIDENT.' },
      { id: "default", conceptId: "default-category", title: "Uma resposta padrão", quick: "Quando nenhuma pista aparece, a resposta é OTHER — nunca ficamos sem resposta." },
    ],
    exercise: { instructions: 'Faça `classify` devolver `"INCIDENT"` quando o texto mencionar "down", e `"OTHER"` em qualquer outro caso.', files: ["classify.ts"], expose: ["classify"] },
    tests: T(
      `test('"production down" → INCIDENT', () => expect(classify("production down")).toBe("INCIDENT"));
test('"the server is down again" → INCIDENT', () => expect(classify("the server is down again")).toBe("INCIDENT"));
test('"lunch menu" → OTHER', () => expect(classify("lunch menu")).toBe("OTHER"));
test('texto vazio → OTHER', () => expect(classify("")).toBe("OTHER"));`,
      "classify.ts",
      "classify",
    ),
    toolbox: [tool.includes, tool.if],
    limitation: '**"Production DOWN"**, em maiúsculas, virou OTHER.',
  },
  {
    slug: "03-ignore-case",
    title: "Maiúsculas não importam",
    subtitle: "Normalizar antes de comparar",
    goal: "Reconhecer a palavra independentemente de maiúsculas.",
    problem: '"Production DOWN" é claramente um incidente, mas `includes("down")` não encontra "DOWN".\n\nComo fazer "Down", "DOWN" e "down" valerem o mesmo?',
    example: 'classify("Production DOWN") → "INCIDENT"',
    minutes: 1,
    introduces: ["text-normalization"],
    prerequisites: ["keyword-match"],
    arch: ARCH_TEXT,
    reference: { "classify.ts": `function classify(text: string): string {\n  const lower = text.toLowerCase();\n  if (lower.includes("down")) return "INCIDENT";\n  return "OTHER";\n}` },
    lineNotes: [{ match: "toLowerCase", note: "Uma cópia do texto toda em minúsculas. Comparamos sempre com essa cópia." }],
    explanation: [
      {
        id: "lower",
        conceptId: "text-normalization",
        title: "Normalizar uma vez",
        quick: "Convertemos o texto para minúsculas antes de procurar. Assim só precisamos procurar \"down\".",
      },
    ],
    exercise: { instructions: 'Faça `classify` reconhecer "down" com qualquer combinação de maiúsculas e minúsculas.', files: ["classify.ts"], expose: ["classify"] },
    tests: T(
      `test('"Production DOWN" → INCIDENT', () => expect(classify("Production DOWN")).toBe("INCIDENT"));
test('"Server Down" → INCIDENT', () => expect(classify("Server Down")).toBe("INCIDENT"));
test('"production down" → INCIDENT', () => expect(classify("production down")).toBe("INCIDENT"));
test('"Lunch Menu" → OTHER', () => expect(classify("Lunch Menu")).toBe("OTHER"));`,
      "classify.ts",
      "classify",
    ),
    toolbox: [tool.lower],
    limitation: 'Tickets reais têm **título e descrição**. Título "Checkout", descrição "the site is down": como olhar os dois?',
  },
  {
    slug: "04-title-and-description",
    title: "Título e descrição",
    subtitle: "A entrada vira um ticket",
    goal: "Classificar um ticket inteiro, não só um texto.",
    problem: 'Um ticket tem **title** e **description**. O incidente pode estar em qualquer um dos dois:\n\ntítulo "Checkout", descrição "the site is down".',
    example: 'classify({ title: "Checkout", description: "the site is down" })\n→ "INCIDENT"',
    minutes: 2,
    introduces: ["ticket-input"],
    prerequisites: ["text-normalization"],
    arch: ARCH_TICKET,
    reference: { "classify.ts": `function classify(${TICKET}): string {\n  const text = (ticket.title + " " + ticket.description).toLowerCase();\n  if (text.includes("down")) return "INCIDENT";\n  return "OTHER";\n}` },
    lineNotes: [
      { match: "ticket: {", note: "O parâmetro agora é um objeto com dois campos: title e description." },
      { match: 'ticket.title + " " + ticket.description', note: "Junta título e descrição (com um espaço no meio) para procurar nos dois de uma vez." },
    ],
    explanation: [
      {
        id: "ticket",
        conceptId: "ticket-input",
        title: "Um ticket é um objeto",
        quick: "`ticket.title` e `ticket.description` são os dois campos. Juntamos os dois e seguimos como antes.",
        normal: "`{ title: string; description: string }` descreve o formato do objeto que entra. No projeto real, esse formato ganha um nome: `TicketInput`.",
      },
    ],
    exercise: { instructions: 'Agora `classify` recebe um ticket com `title` e `description`. É `"INCIDENT"` se "down" (em qualquer caixa) aparecer em qualquer um dos dois; senão, `"OTHER"`.', files: ["classify.ts"], expose: ["classify"] },
    tests: T(
      `test('"down" na descrição → INCIDENT', () => expect(classify({ title: "Checkout", description: "the site is down" })).toBe("INCIDENT"));
test('"DOWN" no título → INCIDENT', () => expect(classify({ title: "Site DOWN", description: "" })).toBe("INCIDENT"));
test('sem "down" → OTHER', () => expect(classify({ title: "Lunch", description: "menu for friday" })).toBe("OTHER"));`,
      "classify.ts",
      "classify",
    ),
    toolbox: [tool.object, tool.concat],
    limitation: '**"Login bug"** virou OTHER: a função só conhece a categoria INCIDENT.',
  },
  {
    slug: "05-more-categories",
    title: "Mais categorias",
    subtitle: "Várias perguntas, em ordem",
    goal: "Reconhecer INCIDENT, BUG e ACCESS.",
    problem: 'Tickets de bug e de acesso também chegam: "Checkout bug", "Cannot login".\n\nComo reconhecer mais de uma categoria?',
    example: '{ title: "Checkout bug", description: "" } → "BUG"\n{ title: "Cannot login", description: "" } → "ACCESS"\n{ title: "Login bug", description: "" }    → "BUG"',
    minutes: 2,
    introduces: ["ordered-checks"],
    prerequisites: ["ticket-input", "default-category"],
    arch: ARCH_TICKET,
    reference: {
      "classify.ts": `function classify(${TICKET}): string {\n  const text = (ticket.title + " " + ticket.description).toLowerCase();\n  if (text.includes("down")) return "INCIDENT";\n  if (text.includes("bug")) return "BUG";\n  if (text.includes("login")) return "ACCESS";\n  return "OTHER";\n}`,
    },
    lineNotes: [
      { match: '"bug"', note: "Uma pergunta nova para uma categoria nova." },
      { match: '"login"', note: 'Só chega aqui se não achou "down" nem "bug". A ordem das perguntas decide quando duas pistas aparecem.' },
    ],
    explanation: [
      {
        id: "order",
        conceptId: "ordered-checks",
        title: "A primeira pista que aparece vence",
        quick: 'As perguntas são feitas em ordem e a função termina no primeiro `return`. "Login bug" vira BUG porque "bug" é perguntado antes de "login".',
      },
    ],
    exercise: {
      instructions: 'Reconheça três categorias, verificando nesta ordem: "down" → `"INCIDENT"`, "bug" → `"BUG"`, "login" → `"ACCESS"`. Nenhuma → `"OTHER"`.',
      files: ["classify.ts"],
      expose: ["classify"],
    },
    tests: T(
      `const t = (title: string, description = "") => classify({ title, description });
test('"Checkout bug" → BUG', () => expect(t("Checkout bug")).toBe("BUG"));
test('"Cannot LOGIN" → ACCESS', () => expect(t("Cannot LOGIN")).toBe("ACCESS"));
test('"Site down" → INCIDENT', () => expect(t("Site down")).toBe("INCIDENT"));
test('"Login bug" → BUG (a ordem decide)', () => expect(t("Login bug")).toBe("BUG"));
test('nenhuma pista → OTHER', () => expect(t("Lunch", "menu")).toBe("OTHER"));`,
      "classify.ts",
      "classify",
    ),
    toolbox: [tool.if],
    limitation: 'Cada categoria real tem **várias** palavras ("outage", "error", "password"…). Com um `if` por palavra, a função vira uma parede de ifs.',
  },
  {
    slug: "06-rules-as-data",
    title: "Regras como dados",
    subtitle: "Uma tabela no lugar dos ifs",
    goal: "Separar as regras (dados) do mecanismo que as aplica.",
    problem: "Cada palavra nova exige mais um `if`. E se as regras fossem uma **lista**, e a função só percorresse essa lista?",
    example: 'Mesmo comportamento da etapa anterior.\nAcrescentar { word: "outage", category: "INCIDENT" } à lista\n→ "Outage" passa a ser INCIDENT, sem mexer na função.',
    minutes: 2,
    introduces: ["rules-as-data"],
    prerequisites: ["ordered-checks"],
    arch: ARCH_RULES,
    reference: {
      "classify.ts": `const RULES = [\n  { word: "down", category: "INCIDENT" },\n  { word: "bug", category: "BUG" },\n  { word: "login", category: "ACCESS" },\n];\n\nfunction classify(${TICKET}): string {\n  const text = (ticket.title + " " + ticket.description).toLowerCase();\n  for (const rule of RULES) {\n    if (text.includes(rule.word)) return rule.category;\n  }\n  return "OTHER";\n}`,
    },
    lineNotes: [
      { match: "const RULES", note: "As três regras da etapa anterior, agora como dados: cada item diz qual palavra leva a qual categoria." },
      { match: "for (const rule of RULES)", note: "Percorre a lista em ordem — a mesma ordem das perguntas de antes." },
      { match: "rule.word", note: "Os ifs viraram um só: a palavra vem da regra, não do código." },
    ],
    explanation: [
      {
        id: "data",
        conceptId: "rules-as-data",
        title: "A tabela manda",
        quick: "Acrescentar uma regra agora é acrescentar uma linha em `RULES`. A função não muda.",
      },
    ],
    exercise: {
      instructions: 'Troque os ifs por uma lista `RULES` (down → INCIDENT, bug → BUG, login → ACCESS, nessa ordem) e faça `classify` percorrê-la. Os testes vão acrescentar uma regra na sua lista e esperar que `classify` passe a respeitá-la.',
      files: ["classify.ts"],
      expose: ["classify", "RULES"],
    },
    tests: T(
      `const t = (title: string, description = "") => classify({ title, description });
test("mesmo comportamento: bug, login, down, ordem, OTHER", () => {
  expect(t("Checkout bug")).toBe("BUG");
  expect(t("Cannot login")).toBe("ACCESS");
  expect(t("Site down")).toBe("INCIDENT");
  expect(t("Login bug")).toBe("BUG");
  expect(t("Lunch")).toBe("OTHER");
});
test("RULES é uma lista de { word, category }", () => {
  expect(RULES.map((r) => r.word)).toEqual(["down", "bug", "login"]);
});
test("uma regra nova na lista muda o resultado sem mexer na função", () => {
  RULES.push({ word: "outage", category: "INCIDENT" });
  expect(t("Outage in EU")).toBe("INCIDENT");
});`,
      "classify.ts",
      "classify, RULES",
    ),
    toolbox: [tool.array, tool.forOf],
    limitation: 'Ticket: **"Cannot login after password reset — the page shows a bug"**. Há mais pistas de ACCESS (login, password) do que de BUG, mas a primeira regra que casa vence.',
  },
  {
    slug: "07-count-evidence",
    title: "Contar evidências",
    subtitle: "Quantas pistas cada categoria tem?",
    goal: "Medir quantas pistas de uma categoria aparecem no texto.",
    problem: "Em vez de parar na primeira pista, queremos **contar** as pistas de cada categoria.\n\nPrimeiro só medir; decidir vem depois.",
    example: 'scoreCategory("ACCESS", "cannot login after password reset") → 2\nscoreCategory("BUG", "cannot login after password reset")    → 0',
    minutes: 2,
    introduces: ["evidence-score"],
    prerequisites: ["rules-as-data"],
    arch: ARCH_SCORE,
    reference: { "score.ts": SCORE_COUNT, "rules.ts": RULES_V1 },
    lineNotes: [
      { match: "let score = 0", note: "Começa sem pontos." },
      { match: "rule.category === category && text.includes(rule.word)", note: "Só conta regras da categoria perguntada, e só se a palavra aparece no texto." },
      { match: "score += 1", note: "Cada pista encontrada vale um ponto." },
      { match: "const RULES", note: "A tabela ganhou mais palavras: duas por categoria." },
    ],
    explanation: [
      {
        id: "score",
        conceptId: "evidence-score",
        title: "Um placar por categoria",
        quick: "`scoreCategory` percorre as regras e soma 1 para cada palavra daquela categoria que aparece no texto.",
      },
    ],
    exercise: {
      instructions: "Crie `scoreCategory(category, text)`: quantas regras de `RULES` daquela categoria aparecem no texto? `RULES` já existe (é a tabela ao lado, de etapas anteriores).",
      files: ["score.ts"],
      expose: ["scoreCategory"],
      support: ["rules.ts"],
    },
    given: { "rules.ts": exp(RULES_V1) },
    tests: T(
      `test("duas pistas de ACCESS", () => expect(scoreCategory("ACCESS", "cannot login after password reset")).toBe(2));
test("nenhuma pista de BUG", () => expect(scoreCategory("BUG", "cannot login after password reset")).toBe(0));
test("duas pistas de BUG", () => expect(scoreCategory("BUG", "error: bug found")).toBe(2));
test("texto vazio → 0", () => expect(scoreCategory("INCIDENT", "")).toBe(0));`,
      "score.ts",
      "scoreCategory",
    ),
    toolbox: [tool.counter, tool.and, tool.forOf],
    limitation: "Temos o placar de cada categoria, mas `classify` ainda escolhe a primeira regra que casa.",
  },
  {
    slug: "08-pick-strongest",
    title: "Escolher a mais forte",
    subtitle: "O maior placar vence",
    goal: "Classificar pela categoria com mais evidência.",
    problem: "Com um placar por categoria, a decisão fica natural: **vence quem tem mais pontos**. E se ninguém pontuar?",
    example: '{ title: "Cannot login", description: "after password reset the page shows a bug" }\n→ "ACCESS"   (ACCESS 2 × BUG 1)',
    minutes: 2,
    introduces: ["highest-score"],
    prerequisites: ["evidence-score", "default-category"],
    arch: ARCH_PICK,
    reference: { "classify.ts": CLASSIFY_PICK, "score.ts": SCORE_COUNT, "rules.ts": RULES_V1 },
    lineNotes: [
      { match: "const CATEGORIES", note: "As categorias que disputam. A ordem importa só em empate." },
      { match: 'let best = "OTHER"', note: "Começa em OTHER com 0 pontos: se ninguém pontuar, é a resposta." },
      { match: "score > bestScore", note: "Troca só se for estritamente maior — em empate, fica quem apareceu antes." },
    ],
    explanation: [
      {
        id: "max",
        conceptId: "highest-score",
        title: "Guardar o melhor até agora",
        quick: "Percorre as categorias guardando a de maior placar. Ninguém pontuou → OTHER. Empate → vence a primeira da lista.",
      },
    ],
    exercise: {
      instructions: 'Reescreva `classify(ticket)`: vence a categoria (INCIDENT, BUG, ACCESS) com maior `scoreCategory`. Nenhum ponto → `"OTHER"`. Empate → a que vem primeiro nessa ordem. `scoreCategory` e `RULES` já existem.',
      files: ["classify.ts"],
      expose: ["classify"],
      support: ["rules.ts", "score.ts"],
    },
    given: { "rules.ts": exp(RULES_V1), "score.ts": imp("RULES", "rules.ts") + exp(SCORE_COUNT) },
    tests: T(
      `const t = (title: string, description = "") => classify({ title, description });
test("mais pistas vence: ACCESS 2 × BUG 1", () => expect(t("Cannot login", "after password reset the page shows a bug")).toBe("ACCESS"));
test("uma pista basta", () => expect(t("Site down")).toBe("INCIDENT"));
test("nenhuma pista → OTHER", () => expect(t("Lunch", "menu")).toBe("OTHER"));
test("empate → a primeira da ordem (INCIDENT antes de BUG)", () => expect(t("bug", "outage")).toBe("INCIDENT"));`,
      "classify.ts",
      "classify",
    ),
    toolbox: [tool.max, tool.forOf],
    limitation: 'Título **"Bug in checkout"**, descrição "the login button looks odd": 1 × 1. Mas quem abriu o ticket resumiu o problema no título — ele deveria pesar mais.',
  },
  {
    slug: "09-title-weight",
    title: "O título pesa o dobro",
    subtitle: "Onde a pista aparece importa",
    goal: "Dar mais peso a pistas no título do que na descrição.",
    problem: "O título é onde a pessoa resume o problema. Uma pista ali deveria valer **mais** do que a mesma pista perdida na descrição.",
    example: 'scoreCategory("BUG", "bug in checkout", "")    → 2\nscoreCategory("BUG", "", "bug in checkout")    → 1',
    minutes: 2,
    introduces: ["title-weight"],
    prerequisites: ["evidence-score"],
    arch: ARCH_PICK,
    reference: { "score.ts": SCORE_TITLE, "classify.ts": CLASSIFY_SPLIT, "rules.ts": RULES_V1 },
    lineNotes: [
      { match: "title.includes(rule.word)) score += 2", note: "Pista no título: 2 pontos." },
      { match: "description.includes(rule.word)) score += 1", note: "Pista na descrição: 1 ponto. A mesma palavra nos dois lugares soma 3." },
      { match: "const title = ticket.title.toLowerCase()", note: "classify agora normaliza título e descrição separadamente, para o placar saber onde cada pista estava." },
    ],
    explanation: [
      {
        id: "title",
        conceptId: "title-weight",
        title: "Posição é evidência",
        quick: "Mesma pista, pesos diferentes: título vale 2, descrição vale 1.",
        normal: "É uma hipótese de produto, não uma verdade: o projeto real mede se ela melhora a classificação com datasets de avaliação.",
      },
    ],
    exercise: {
      instructions: "Reescreva `scoreCategory(category, title, description)`: cada pista da categoria vale 2 no título e 1 na descrição. `RULES` já existe.",
      files: ["score.ts"],
      expose: ["scoreCategory"],
      support: ["rules.ts"],
    },
    given: { "rules.ts": exp(RULES_V1) },
    tests: T(
      `test("pista no título vale 2", () => expect(scoreCategory("BUG", "bug in checkout", "")).toBe(2));
test("pista na descrição vale 1", () => expect(scoreCategory("BUG", "", "bug in checkout")).toBe(1));
test("título e descrição somam", () => expect(scoreCategory("ACCESS", "cannot login", "password reset")).toBe(3));
test("outra categoria não conta", () => expect(scoreCategory("INCIDENT", "cannot login", "password reset")).toBe(0));`,
      "score.ts",
      "scoreCategory",
    ),
    toolbox: [tool.and, tool.counter],
    limitation: '"error" aparece em quase todo ticket; "down" é quase certeza de incidente. Hoje **as duas pistas valem o mesmo**.',
  },
  {
    slug: "10-signal-weights",
    title: "Sinais fortes e fracos",
    subtitle: "Cada pista tem um peso",
    goal: "Dar a cada pista uma força diferente.",
    problem: 'Uma pista forte ("down") deveria valer mais que uma fraca ("error"). Onde guardar essa força?',
    example: 'scoreCategory("BUG", "error", "")          → 2   (peso 1, no título)\nscoreCategory("INCIDENT", "", "outage")    → 4   (peso 4, na descrição)',
    minutes: 2,
    introduces: ["weighted-signals"],
    prerequisites: ["title-weight", "rules-as-data"],
    arch: ARCH_PICK,
    reference: { "score.ts": SCORE_WEIGHTED, "rules.ts": RULES_WEIGHTED },
    lineNotes: [
      { match: "weight: 5", note: '"down" é a pista mais forte de incidente.' },
      { match: "weight: 1", note: '"error" aparece em todo lugar: pista fraca.' },
      { match: "rule.weight * 2", note: "O peso da pista, dobrado no título." },
      { match: "score += rule.weight;", note: "O peso da pista, simples na descrição." },
    ],
    explanation: [
      {
        id: "weights",
        conceptId: "weighted-signals",
        title: "A força mora na tabela",
        quick: "Cada regra ganhou `weight`. O placar soma o peso (dobrado no título) em vez de 1.",
      },
    ],
    exercise: {
      instructions: "Reescreva `scoreCategory(category, title, description)` usando o `weight` de cada regra: no título vale o dobro do peso, na descrição vale o peso. `RULES` (agora com pesos) já existe.",
      files: ["score.ts"],
      expose: ["scoreCategory"],
      support: ["rules.ts"],
    },
    given: { "rules.ts": exp(RULES_WEIGHTED) },
    tests: T(
      `test("pista fraca no título: 1 × 2", () => expect(scoreCategory("BUG", "error", "")).toBe(2));
test("pista fraca na descrição: 1", () => expect(scoreCategory("BUG", "", "error")).toBe(1));
test("pista forte na descrição: 4", () => expect(scoreCategory("INCIDENT", "", "outage")).toBe(4));
test("soma de pistas e posições", () => expect(scoreCategory("INCIDENT", "down", "outage")).toBe(14));`,
      "score.ts",
      "scoreCategory",
    ),
    toolbox: [tool.counter],
    limitation: 'Descrição **"login fails with a bug error"**: ACCESS 4 × BUG 4. O empate cai para quem vem primeiro em `CATEGORIES` — uma ordem que ninguém escolheu de propósito.',
  },
  {
    slug: "11-safe-tie-break",
    title: "Empate seguro",
    subtitle: "A ordem vira uma decisão",
    goal: "Decidir, de propósito, quem vence um empate.",
    problem: "Em empate, qual erro é mais caro? Tratar um incidente como bug deixa produção fora do ar esperando na fila. Tratar um bug como incidente custa alguns minutos de atenção.",
    example: '{ title: "", description: "login fails with a bug error" }\n→ "ACCESS"   (empate 4 × 4: ACCESS vem antes de BUG)',
    minutes: 1,
    introduces: ["tie-break"],
    prerequisites: ["highest-score"],
    arch: ARCH_TIE,
    reference: { "classify.ts": CLASSIFY_TIE, "score.ts": SCORE_WEIGHTED, "rules.ts": RULES_WEIGHTED },
    lineNotes: [
      { match: "const TIE_BREAK", note: "Mesma lista de antes, com nome e ordem escolhidos: incidentes primeiro, depois acesso, depois bug." },
      { match: "for (const category of TIE_BREAK)", note: "Como só troca com placar estritamente maior, a primeira da lista vence os empates." },
    ],
    explanation: [
      {
        id: "tie",
        conceptId: "tie-break",
        title: "Errar para o lado seguro",
        quick: "A lista `TIE_BREAK` torna explícita uma decisão de produto: em empate, INCIDENT > ACCESS > BUG.",
      },
    ],
    exercise: {
      instructions: 'Reescreva `classify(ticket)` com a ordem de desempate INCIDENT, ACCESS, BUG. Continua: maior placar vence, nenhum ponto → `"OTHER"`. `scoreCategory(category, title, description)` e `RULES` já existem.',
      files: ["classify.ts"],
      expose: ["classify"],
      support: ["rules.ts", "score.ts"],
    },
    given: { "rules.ts": exp(RULES_WEIGHTED), "score.ts": imp("RULES", "rules.ts") + exp(SCORE_WEIGHTED) },
    tests: T(
      `const t = (title: string, description = "") => classify({ title, description });
test("empate ACCESS × BUG → ACCESS", () => expect(t("", "login fails with a bug error")).toBe("ACCESS"));
test("título pesa: BUG", () => expect(t("Checkout bug", "")).toBe("BUG"));
test("incidente", () => expect(t("Site DOWN", "")).toBe("INCIDENT"));
test("nada → OTHER", () => expect(t("Lunch", "menu")).toBe("OTHER"));`,
      "classify.ts",
      "classify",
    ),
    toolbox: [tool.max],
    limitation: '**"Debug mode is slow"** virou BUG: "bug" está dentro de "debug". `includes` procura pedaços, não palavras.',
  },
  {
    slug: "12-whole-words",
    title: "Palavra inteira",
    subtitle: '"debug" não é "bug"',
    goal: "Fazer cada pista casar só com a palavra inteira.",
    problem: '"debug" contém "bug"; "downloads" contém "down". Precisamos casar a **palavra**, não um pedaço dela.',
    example: 'scoreCategory("BUG", "debug mode is slow", "")      → 0\nscoreCategory("INCIDENT", "", "downloads are slow")  → 0\nscoreCategory("BUG", "bug in checkout", "")          → 6',
    minutes: 2,
    introduces: ["regex-word-boundary"],
    prerequisites: ["weighted-signals"],
    arch: ARCH_TIE,
    reference: { "rules.ts": RULES_REGEX, "score.ts": SCORE_REGEX },
    lineNotes: [
      { match: String.raw`/\bdown\b/`, note: String.raw`Uma expressão regular. \b marca onde uma palavra começa ou termina: casa "down", não "downloads".` },
      { match: "rule.pattern.test(title)", note: "`.test` pergunta se o padrão casa no texto — o papel que `includes` fazia." },
    ],
    explanation: [
      {
        id: "regex",
        conceptId: "regex-word-boundary",
        title: "Padrões em vez de pedaços",
        quick: "Cada regra guarda um padrão (`/\\bbug\\b/`) em vez de uma palavra. `\\b` exige que seja uma palavra inteira.",
      },
    ],
    exercise: {
      instructions: 'Reescreva a tabela `RULES` com as mesmas pistas, categorias e pesos, mas cada pista deve casar só a palavra inteira. Cada regra precisa de um campo `pattern` — é ele que `scoreCategory` (já pronta) usa.',
      files: ["rules.ts"],
      expose: ["RULES"],
      support: ["score.ts"],
    },
    given: { "score.ts": imp("RULES", "rules.ts") + exp(SCORE_REGEX) },
    tests: `import { test, expect } from "replay:test";
import { scoreCategory } from "./score.ts";

test('"debug" não conta como "bug"', () => expect(scoreCategory("BUG", "debug mode is slow", "")).toBe(0));
test('"downloads" não conta como "down"', () => expect(scoreCategory("INCIDENT", "", "downloads are slow")).toBe(0));
test("bug no título: 3 × 2", () => expect(scoreCategory("BUG", "bug in checkout", "")).toBe(6));
test("down no título: 5 × 2", () => expect(scoreCategory("INCIDENT", "server down", "")).toBe(10));
test("login e password na descrição: 4 + 2", () => expect(scoreCategory("ACCESS", "", "login after password reset")).toBe(6));
test("outage (4) e error (1) continuam valendo", () => {
  expect(scoreCategory("INCIDENT", "", "outage")).toBe(4);
  expect(scoreCategory("BUG", "", "error")).toBe(1);
});
`,
    toolbox: [tool.regex, tool.boundary],
    limitation: 'As categorias são strings soltas. Um **"INCIDNET"** digitado errado na tabela nunca casaria com nada — e ninguém seria avisado.',
  },
  {
    slug: "13-named-categories",
    title: "Categorias com nome",
    subtitle: "Um conjunto fechado",
    goal: "Tornar as categorias possíveis um conjunto fechado e nomeado.",
    problem: 'Qualquer string passa por categoria: "INCIDNET", "incident", "Incident". Queremos que só existam INCIDENT, BUG, ACCESS e OTHER — e que um erro de digitação seja apontado.',
    example: "Category.INCIDENT → \"INCIDENT\"\nclassify(...) devolve Category.ACCESS, não uma string solta",
    minutes: 1,
    introduces: ["string-enum"],
    prerequisites: ["tie-break"],
    arch: ARCH_ENUM,
    reference: { "category.ts": CATEGORY_ENUM, "rules.ts": RULES_ENUM, "classify.ts": CLASSIFY_ENUM },
    lineNotes: [
      { match: "enum Category", note: "Declara o conjunto fechado de categorias." },
      { match: 'INCIDENT = "INCIDENT"', note: 'Cada membro tem um nome e um valor. Em runtime, Category.INCIDENT é a própria string "INCIDENT".' },
      { match: "Category.INCIDENT, weight: 5", note: "A tabela passa a usar os nomes. Category.INCIDNET não existe: o TypeScript aponta o erro antes de rodar." },
    ],
    explanation: [
      {
        id: "enum",
        conceptId: "string-enum",
        title: "Nomes em vez de strings soltas",
        quick: "`enum Category` lista as quatro categorias. Tabela e `classify` passam a usar `Category.X`.",
        normal: 'Em runtime nada muda — `Category.BUG === "BUG"`. O ganho é no editor: digitar `Category.BUGG` é erro de compilação, e o autocompletar mostra as opções.',
      },
    ],
    exercise: {
      instructions: "Crie o `enum Category` com INCIDENT, BUG, ACCESS e OTHER, cada um valendo o próprio nome como texto. A tabela e `classify` (já prontas) usam `Category`.",
      files: ["category.ts"],
      expose: ["Category"],
      support: ["rules.ts", "score.ts", "classify.ts"],
    },
    given: {
      "rules.ts": imp("Category", "category.ts") + exp(RULES_ENUM),
      "score.ts": imp("RULES", "rules.ts") + exp(SCORE_REGEX),
      "classify.ts": imp("Category", "category.ts") + imp("scoreCategory", "score.ts") + exp(CLASSIFY_ENUM),
    },
    tests: `import { test, expect } from "replay:test";
import { Category } from "./category.ts";
import { classify } from "./classify.ts";

test("quatro categorias, cada uma valendo o próprio nome", () => {
  expect(Category.INCIDENT).toBe("INCIDENT");
  expect(Category.BUG).toBe("BUG");
  expect(Category.ACCESS).toBe("ACCESS");
  expect(Category.OTHER).toBe("OTHER");
});
test("classify devolve membros de Category", () => {
  expect(classify({ title: "Cannot login", description: "" })).toBe(Category.ACCESS);
  expect(classify({ title: "Lunch", description: "" })).toBe(Category.OTHER);
});
`,
    toolbox: [tool.enumT],
    limitation: "Você reconstruiu cada peça separadamente. Consegue montar o classificador inteiro, **do zero, sem olhar**?",
  },
];

// ---------- module checkpoint ----------
const CONSOLIDATED = String.raw`enum Category {
  INCIDENT = "INCIDENT",
  BUG = "BUG",
  ACCESS = "ACCESS",
  OTHER = "OTHER",
}

const RULES = [
  { pattern: /\bdown\b/, category: Category.INCIDENT, weight: 5 },
  { pattern: /\boutage\b/, category: Category.INCIDENT, weight: 4 },
  { pattern: /\bbug\b/, category: Category.BUG, weight: 3 },
  { pattern: /\berror\b/, category: Category.BUG, weight: 1 },
  { pattern: /\blogin\b/, category: Category.ACCESS, weight: 4 },
  { pattern: /\bpassword\b/, category: Category.ACCESS, weight: 2 },
];

// Em empate vence quem vem primeiro: ignorar um incidente é o erro mais caro.
const TIE_BREAK = [Category.INCIDENT, Category.ACCESS, Category.BUG];

function scoreCategory(category: Category, title: string, description: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && rule.pattern.test(title)) score += rule.weight * 2;
    if (rule.category === category && rule.pattern.test(description)) score += rule.weight;
  }
  return score;
}

function classify(ticket: { title: string; description: string }): Category {
  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();
  let best = Category.OTHER;
  let bestScore = 0;
  for (const category of TIE_BREAK) {
    const score = scoreCategory(category, title, description);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}`;

const checkpoint: Micro = {
  slug: "99-checkpoint",
  kind: "checkpoint",
  title: "Checkpoint: o classificador inteiro",
  subtitle: "Do zero, sem olhar",
  goal: "Reconstruir sozinho o classificador determinístico completo e compará-lo com o código real.",
  problem: "Juntar todas as peças do módulo em um arquivo, começando do editor vazio. Depois, comparar a sua versão com a versão consolidada do Replay e com o código real do ops-triage-ai.",
  example: [
    "Categorias: INCIDENT, BUG, ACCESS, OTHER (Category)",
    "Pistas (palavra inteira, sem diferenciar maiúsculas) e pesos:",
    "  down 5, outage 4 → INCIDENT · bug 3, error 1 → BUG · login 4, password 2 → ACCESS",
    "scoreCategory(category, title, description): título vale o dobro",
    "classify(ticket): maior placar; empate → INCIDENT, ACCESS, BUG; nada → OTHER",
  ].join("\n"),
  minutes: 5,
  introduces: [],
  prerequisites: ["string-enum", "regex-word-boundary", "tie-break", "weighted-signals", "title-weight"],
  arch: ARCH_ENUM,
  reference: { "classifier.ts": CONSOLIDATED },
  lineNotes: [],
  explanation: [
    {
      id: "real",
      title: "O que o código real faz a mais",
      quick: "O mesmo esqueleto — sinais com peso, título em dobro, desempate explícito — com mais categorias e mais sinais por categoria.",
      normal: "No `DeterministicTriageClassifier` real, cada sinal também tem um `label` (\"production_down\") usado para explicar a decisão; `normalize` remove acentos e pontuação; e o resultado não é só a categoria: inclui confiança, prioridade, risco e time sugerido. Esses são os próximos módulos.",
    },
  ],
  exercise: {
    instructions: "Reconstrua em `classifier.ts`, do zero: `Category`, as regras, `scoreCategory(category, title, description)` e `classify(ticket)`. Os requisitos estão acima; o resto é com você.",
    files: ["classifier.ts"],
    expose: ["Category", "scoreCategory", "classify"],
  },
  tests: `import { test, expect } from "replay:test";
import { Category, classify, scoreCategory } from "./classifier.ts";

const t = (title: string, description = "") => classify({ title, description });

test("Category tem as quatro categorias", () => {
  expect([Category.INCIDENT, Category.BUG, Category.ACCESS, Category.OTHER]).toEqual(["INCIDENT", "BUG", "ACCESS", "OTHER"]);
});
test("pesos e título em dobro", () => {
  expect(scoreCategory(Category.INCIDENT, "down", "outage")).toBe(14);
  expect(scoreCategory(Category.BUG, "error", "bug")).toBe(5);
  expect(scoreCategory(Category.ACCESS, "", "login after password reset")).toBe(6);
});
test("só palavras inteiras", () => {
  expect(scoreCategory(Category.BUG, "debug mode", "")).toBe(0);
  expect(t("Downloads are slow")).toBe(Category.OTHER);
});
test("maiúsculas não importam", () => expect(t("Production DOWN")).toBe(Category.INCIDENT));
test("mais evidência vence", () => expect(t("Cannot login", "after password reset the page shows a bug")).toBe(Category.ACCESS));
test("empate: INCIDENT > ACCESS > BUG", () => {
  expect(t("", "login fails with a bug error")).toBe(Category.ACCESS);
  expect(t("", "outage login")).toBe(Category.INCIDENT);
});
test("sem pistas → OTHER", () => expect(t("Lunch", "menu")).toBe(Category.OTHER));
`,
  toolbox: [tool.enumT, tool.regex, tool.boundary, tool.forOf, tool.max, tool.lower],
  originalCodeRefs: [
    { path: "src/domain/triage.ts", startLine: 1, endLine: 9, symbol: "Category", replayFile: "classifier.ts", note: "O mesmo enum, com 7 categorias (inclui FEATURE_REQUEST, CONTENT_CHANGE e SUPPORT). Mora na camada de domínio." },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 24, endLine: 66, symbol: "CATEGORY_SIGNALS", replayFile: "classifier.ts", replaySymbol: "RULES", note: "Nossa tabela RULES, organizada por categoria (Record<Category, ...>), com vários sinais por categoria e um label por sinal para explicar a decisão." },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 68, endLine: 77, symbol: "CATEGORY_TIE_BREAK", replayFile: "classifier.ts", note: 'Nosso TIE_BREAK, com o mesmo raciocínio no comentário: "Safety-sensitive operational categories win."' },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 116, endLine: 132, symbol: "scoreCategory", replayFile: "classifier.ts", note: "Idêntico em lógica: peso × 2 no título, peso na descrição. Também devolve quais sinais casaram (matched)." },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 78, endLine: 114, symbol: "classify", replayFile: "classifier.ts", note: "Nosso classify, mais: confiança pela margem entre 1º e 2º colocados, prioridade, risco, time sugerido e justificativa." },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 221, endLine: 229, symbol: "normalize", replayFile: "classifier.ts", replaySymbol: "classify", note: "Nosso toLowerCase, mais remoção de acentos e pontuação." },
  ],
  checkpoint: {
    question: "No código real, por que o título ter peso dobrado é uma decisão que precisa ser medida, e não uma verdade?",
    answer: "Porque é uma hipótese sobre como as pessoas escrevem tickets. O projeto real avalia o classificador em datasets rotulados: se dobrar o título piorasse os acertos, o peso mudaria. Os pesos são parâmetros de produto, não fatos.",
  },
};

// ---------- write ----------
function write(stage: Micro): void {
  const dir = join(ROOT, stage.slug);
  mkdirSync(join(dir, "reference"), { recursive: true });
  for (const [file, content] of Object.entries(stage.reference)) writeFileSync(join(dir, "reference", file), content + "\n");
  if (stage.given) {
    mkdirSync(join(dir, "given"), { recursive: true });
    for (const [file, content] of Object.entries(stage.given)) writeFileSync(join(dir, "given", file), content + "\n");
  }
  writeFileSync(join(dir, "tests.ts"), stage.tests);
  const json = {
    kind: stage.kind ?? "micro",
    title: stage.title,
    ...(stage.subtitle ? { subtitle: stage.subtitle } : {}),
    goal: stage.goal,
    problem: stage.problem,
    ...(stage.example ? { example: stage.example } : {}),
    estimatedMinutes: stage.minutes,
    introduces: stage.introduces,
    prerequisites: stage.prerequisites,
    architecture: stage.arch,
    referenceCode: Object.keys(stage.reference),
    lineNotes: stage.lineNotes,
    explanation: stage.explanation,
    ...(stage.originalCodeRefs ? { originalCodeRefs: stage.originalCodeRefs } : {}),
    exercise: {
      instructions: stage.exercise.instructions,
      files: stage.exercise.files,
      ...(stage.exercise.support ? { supportFiles: stage.exercise.support } : {}),
      expose: stage.exercise.expose,
    },
    toolbox: stage.toolbox,
    ...(stage.checkpoint ? { checkpoint: stage.checkpoint } : {}),
    ...(stage.limitation ? { limitation: stage.limitation } : {}),
  };
  writeFileSync(join(dir, "stage.json"), JSON.stringify(json, null, 2) + "\n");
}

for (const stage of [...stages, checkpoint]) write(stage);
console.log([...stages, checkpoint].map((s) => "m1/" + s.slug).join("\n"));
