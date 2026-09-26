// Authoring source of Module 1 (micro stages + checkpoint) of the ops-triage-ai golden journey.
// Regenerates data/golden/ops-triage-ai/stages/m1: edit here, run `bun run author:m1`, then `bun test`.
//
// Module 1 is ONE program, classify.ts, evolved step by step. Each micro stage is the previous
// state plus one small change; the learner keeps editing their own code. The checkpoint asks for
// the final state again, from an empty editor.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../data/golden/ops-triage-ai/stages/m1");
const FILE = "classify.ts";

type Node = { id: string; label: string; kind: string; col: number; row: number };
type Edge = { from: string; to: string; rel: string };
type Tool = { id: string; name: string; signature?: string; summary: string; example: string; whenToUse?: string };
type Example = { expr: string; equals: string };
type Step = {
  slug: string;
  title: string;
  subtitle: string;
  goal: string;
  problem: string;
  examples: Example[];
  minutes: number;
  introduces: string[];
  prerequisites: string[];
  arch: { nodes: Node[]; edges: Edge[] };
  /** The whole program after this step. */
  program: string;
  lineNotes: { match: string; note: string }[];
  explanation: { id: string; conceptId?: string; title: string; quick: string; normal?: string }[];
  instructions: string;
  expose: string[];
  /** Type-level checks, when the step teaches types (verified by the real tsc). */
  typecheck?: string;
  tests: string;
  toolbox: Tool[];
  limitation?: string;
  noveltyException?: string;
};

// ---------- the program, state by state ----------
const TICKET = "ticket: { title: string; description: string }";
const LOWER = `  const lower = (ticket.title + " " + ticket.description).toLowerCase();`;
const TITLE_DESC = `  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();`;

const P1 = `function classify(text: string): string {
  return "INCIDENT";
}`;

const P2 = `function classify(text: string): string {
  if (text.includes("down")) {
    return "INCIDENT";
  }
  return "OTHER";
}`;

const P3 = `function classify(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("down")) {
    return "INCIDENT";
  }
  return "OTHER";
}`;

const P4 = `function classify(${TICKET}): string {
${LOWER}
  if (lower.includes("down")) {
    return "INCIDENT";
  }
  return "OTHER";
}`;

const P5 = `function classify(${TICKET}): string {
${LOWER}
  if (lower.includes("down")) {
    return "INCIDENT";
  }
  if (lower.includes("bug")) {
    return "BUG";
  }
  if (lower.includes("login")) {
    return "ACCESS";
  }
  return "OTHER";
}`;

const RULES_3 = `const RULES = [
  { word: "down", category: "INCIDENT" },
  { word: "bug", category: "BUG" },
  { word: "login", category: "ACCESS" },
];`;

const RULES_6 = `const RULES = [
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

const FIRST_MATCH = `function classify(${TICKET}): string {
${LOWER}
  for (const rule of RULES) {
    if (lower.includes(rule.word)) {
      return rule.category;
    }
  }
  return "OTHER";
}`;

const SCORE_COUNT = `function scoreCategory(category: string, text: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && text.includes(rule.word)) {
      score += 1;
    }
  }
  return score;
}`;

const scoreBy = (test: (where: string) => string, title: string, description: string) => `function scoreCategory(category: string, title: string, description: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && ${test("title")}) {
      score += ${title};
    }
    if (rule.category === category && ${test("description")}) {
      score += ${description};
    }
  }
  return score;
}`;
const SCORE_TITLE = scoreBy((w) => `${w}.includes(rule.word)`, "2", "1");
const SCORE_WEIGHTED = scoreBy((w) => `${w}.includes(rule.word)`, "rule.weight * 2", "rule.weight");
const SCORE_REGEX = scoreBy((w) => `rule.pattern.test(${w})`, "rule.weight * 2", "rule.weight");

// Comparing two scores, then keeping the best so far. "OTHER" has no rules, so its score is 0:
// comparing against scoreCategory(best) needs no extra variable for the best score.
const COMPARE_PAIR = `function classify(${TICKET}): string {
${LOWER}
  if (scoreCategory("ACCESS", lower) > scoreCategory("BUG", lower)) {
    return "ACCESS";
  }
  for (const rule of RULES) {
    if (lower.includes(rule.word)) {
      return rule.category;
    }
  }
  return "OTHER";
}`;

const best = (list: string, returns = "string", start = `"OTHER"`, split = true) => {
  const args = split ? "title, description" : "lower";
  return `function classify(${TICKET}): ${returns} {
${split ? TITLE_DESC : LOWER}
  let best = ${start};
  for (const category of ${list}) {
    if (scoreCategory(category, ${args}) > scoreCategory(best, ${args})) {
      best = category;
    }
  }
  return best;
}`;
};

const CATEGORIES = `const CATEGORIES = ["INCIDENT", "BUG", "ACCESS"];`;
const TIE_BREAK = `// Em empate vence quem vem primeiro: ignorar um incidente é o erro mais caro.
const TIE_BREAK = ["INCIDENT", "ACCESS", "BUG"];`;
const TIE_BREAK_ENUM = `// Em empate vence quem vem primeiro: ignorar um incidente é o erro mais caro.
const TIE_BREAK = [Category.INCIDENT, Category.ACCESS, Category.BUG];`;
const ENUM = `enum Category {
  INCIDENT = "INCIDENT",
  BUG = "BUG",
  ACCESS = "ACCESS",
  OTHER = "OTHER",
}`;

const join2 = (...parts: string[]) => parts.join("\n\n");
const P6 = join2(RULES_3, FIRST_MATCH);
const P7 = join2(RULES_6, FIRST_MATCH);
const P8 = join2(RULES_6, SCORE_COUNT, FIRST_MATCH);
const P9 = join2(RULES_6, SCORE_COUNT, COMPARE_PAIR);
const P10 = join2(RULES_6, SCORE_COUNT, CATEGORIES, best("CATEGORIES", "string", `"OTHER"`, false));
const P11 = join2(RULES_6, SCORE_TITLE, CATEGORIES, best("CATEGORIES"));
const P12 = join2(RULES_WEIGHTED, SCORE_WEIGHTED, CATEGORIES, best("CATEGORIES"));
const P13 = join2(RULES_WEIGHTED, SCORE_WEIGHTED, TIE_BREAK, best("TIE_BREAK"));
const P14 = join2(RULES_REGEX, SCORE_REGEX, TIE_BREAK, best("TIE_BREAK"));
const P15 = join2(ENUM, RULES_REGEX, SCORE_REGEX, TIE_BREAK, best("TIE_BREAK"));
const P16 = join2(ENUM, RULES_REGEX, SCORE_REGEX, TIE_BREAK_ENUM, best("TIE_BREAK", "Category", "Category.OTHER"));
const P17 = join2(ENUM, RULES_ENUM, SCORE_REGEX, TIE_BREAK_ENUM, best("TIE_BREAK", "Category", "Category.OTHER"));

// ---------- tests ----------
const T = (names: string, body: string) => `import { test, expect } from "replay:test";\nimport { ${names} } from "./${FILE}";\n\n${body.trim()}\n`;
const TICKETS = `const t = (title: string, description = "") => classify({ title, description });\n`;

// ---------- architecture snapshots (only what has been learned) ----------
const n = (id: string, label: string, kind: string, col: number, row = 0): Node => ({ id, label, kind, col, row });
const e = (from: string, to: string, rel = "flows_to"): Edge => ({ from, to, rel });
const ARCH_TEXT = { nodes: [n("text", "texto", "data", 0), n("classify", "classify()", "function", 1), n("category", "categoria", "data", 2)], edges: [e("text", "classify"), e("classify", "category", "creates")] };
const ARCH_TICKET = { nodes: [n("ticket", "ticket", "data", 0), n("classify", "classify()", "function", 1), n("category", "categoria", "data", 2)], edges: [e("ticket", "classify"), e("classify", "category", "creates")] };
const ARCH_RULES = { nodes: [...ARCH_TICKET.nodes, n("rules", "RULES", "data", 1, 1)], edges: [...ARCH_TICKET.edges, e("classify", "rules", "reads")] };
const ARCH_SCORE = { nodes: [...ARCH_RULES.nodes, n("score", "scoreCategory()", "function", 2, 1)], edges: [...ARCH_RULES.edges, e("score", "rules", "reads")] };
const ARCH_PICK = { nodes: ARCH_SCORE.nodes, edges: [...ARCH_TICKET.edges, e("classify", "score", "calls"), e("score", "rules", "reads")] };
const ARCH_TIE = { nodes: [...ARCH_PICK.nodes, n("tie", "TIE_BREAK", "data", 0, 1)], edges: [...ARCH_PICK.edges, e("classify", "tie", "reads")] };
const ARCH_ENUM = { nodes: ARCH_TIE.nodes.map((x) => (x.id === "category" ? { ...x, label: "Category" } : x)), edges: ARCH_TIE.edges };

// ---------- toolbox: every example is a complete, valid program (the validator type-checks each) ----------
const tool = {
  fn: { id: "function", name: "function", signature: "function nome(param: Tipo): Tipo { ... }", summary: "Declara uma função: recebe parâmetros e devolve um valor com return.", example: "function double(n: number): number {\n  return n * 2;\n}\n\ndouble(21); // 42" },
  ret: { id: "return", name: "return", summary: "Dentro de uma função: encerra e devolve o valor.", example: 'function greet(name: string): string {\n  return "oi " + name;\n}' },
  includes: { id: "includes", name: "String.includes()", signature: "texto.includes(pedaço): boolean", summary: "true se o texto contém o pedaço.", example: '"server down".includes("down"); // true\n"lunch".includes("down"); // false' },
  if: { id: "if", name: "if", summary: "Executa um bloco só quando a condição é verdadeira.", example: 'function kind(age: number): string {\n  if (age >= 18) {\n    return "adulto";\n  }\n  return "menor";\n}' },
  lower: { id: "to-lower", name: "String.toLowerCase()", summary: "Cópia do texto em minúsculas.", example: '"Server DOWN".toLowerCase(); // "server down"' },
  object: { id: "object-param", name: "Objeto como parâmetro", summary: "Um valor com campos nomeados; leia cada campo com ponto.", example: 'function greet(user: { name: string }): string {\n  return "oi " + user.name;\n}\n\ngreet({ name: "Ana" }); // "oi Ana"' },
  concat: { id: "concat", name: "Juntar textos (+)", summary: "+ entre strings concatena.", example: 'const full = "a" + " " + "b"; // "a b"' },
  array: { id: "array-objects", name: "Array de objetos", summary: "Uma lista de itens com o mesmo formato.", example: 'const fruits = [\n  { name: "maçã", color: "red" },\n  { name: "banana", color: "yellow" },\n];' },
  forOf: { id: "for-of", name: "for...of", signature: "for (const item of lista) { ... }", summary: "Percorre os itens de uma lista, em ordem.", example: 'const fruits = [{ name: "maçã", color: "red" }];\n\nfunction firstRed(): string {\n  for (const fruit of fruits) {\n    if (fruit.color === "red") {\n      return fruit.name;\n    }\n  }\n  return "nenhuma";\n}' },
  push: { id: "array-literal", name: "Mais itens na lista", summary: "Uma lista literal cresce acrescentando itens entre os colchetes.", example: 'const colors = [\n  "red",\n  "blue",\n  "green",\n];' },
  compare: { id: "compare", name: "Comparar números (>)", summary: "a > b é true quando a é estritamente maior que b.", example: 'const a = 2;\nconst b = 1;\nif (a > b) {\n  console.log("a vence");\n}' },
  counter: { id: "counter", name: "Contador (+=)", summary: "Comece em 0 e some dentro do laço.", example: "let total = 0;\nfor (const n of [1, 2, 3]) {\n  total += n;\n}\n// total === 6" },
  and: { id: "and", name: "&& (e)", summary: "Verdadeiro só se os dois lados forem.", example: 'const fruit = { color: "red", ripe: true };\nif (fruit.color === "red" && fruit.ripe) {\n  console.log("pronta");\n}' },
  max: { id: "running-max", name: "Guardar o maior até agora", summary: "Duas variáveis: o melhor item e seu valor; troque quando achar um maior.", example: 'const players = [{ name: "Ana", points: 3 }, { name: "Bia", points: 5 }];\nlet best = "";\nlet bestPoints = 0;\nfor (const p of players) {\n  if (p.points > bestPoints) {\n    best = p.name;\n    bestPoints = p.points;\n  }\n}\n// best === "Bia"' },
  regex: { id: "regex-test", name: "RegExp.test()", signature: "/padrão/.test(texto): boolean", summary: "true se o padrão casa em algum lugar do texto.", example: '/cat/.test("concatenate"); // true' },
  boundary: { id: "word-boundary", name: String.raw`\b (fronteira de palavra)`, summary: "Casa onde uma palavra começa ou termina.", example: String.raw`/\bcat\b/.test("concatenate"); // false` + "\n" + String.raw`/\bcat\b/.test("my cat"); // true` },
  enumT: { id: "enum", name: "enum", signature: 'enum Nome { A = "A", B = "B" }', summary: "Um conjunto fechado de valores com nome.", example: 'enum Color {\n  RED = "RED",\n  BLUE = "BLUE",\n}\n\nconst c: Color = Color.RED; // "RED"' },
} satisfies Record<string, Tool>;

// ---------- the micro stages ----------
const steps: Step[] = [
  {
    slug: "01-fixed-answer",
    title: "Uma resposta fixa",
    subtitle: "Entra um texto, sai uma categoria",
    goal: "Ter uma função que recebe o texto de um ticket e devolve uma categoria.",
    problem: 'Queremos classificar o ticket **"production down"** como **INCIDENT**.\n\nQual é o programa mais simples possível que faz isso?',
    examples: [{ expr: 'classify("production down")', equals: '"INCIDENT"' }],
    minutes: 1,
    introduces: ["function-io"],
    prerequisites: [],
    arch: ARCH_TEXT,
    program: P1,
    lineNotes: [
      { match: "function classify", note: "Declara a função classify. `text` é o que entra; o `: string` depois dos parênteses diz que sai um texto." },
      { match: 'return "INCIDENT"', note: "Sempre a mesma resposta. A função ainda nem olha o texto — de propósito." },
    ],
    explanation: [
      {
        id: "io",
        conceptId: "function-io",
        title: "Entra texto, sai categoria",
        quick: 'Uma função é uma caixa: entra o texto do ticket, sai uma categoria. Esta devolve sempre `"INCIDENT"`.',
        normal: "`text: string` e `: string` são anotações do TypeScript: dizem o que entra e o que sai. Sem elas, é JavaScript puro — e funcionaria igual.",
      },
    ],
    instructions: 'Crie uma função `classify` que recebe um texto e devolve `"INCIDENT"`.',
    expose: ["classify"],
    tests: T("classify", `test('classify("production down") → "INCIDENT"', () => expect(classify("production down")).toBe("INCIDENT"));`),
    toolbox: [tool.fn, tool.ret],
    limitation: 'Mas agora **"lunch menu"** também vira INCIDENT.',
  },
  {
    slug: "02-look-at-text",
    title: "Olhar o texto",
    subtitle: "Uma palavra decide",
    goal: "Decidir a categoria a partir de uma palavra do texto.",
    problem: '"lunch menu" não é um incidente, mas a função diz que é.\n\nComo decidir **olhando o texto**?',
    examples: [
      { expr: 'classify("server down")', equals: '"INCIDENT"' },
      { expr: 'classify("lunch menu")', equals: '"OTHER"' },
    ],
    minutes: 1,
    introduces: ["keyword-match", "default-category"],
    prerequisites: ["function-io"],
    arch: ARCH_TEXT,
    program: P2,
    lineNotes: [
      { match: 'text.includes("down")', note: '`includes` responde true/false: o texto contém "down"? Se sim, o bloco do `if` roda.' },
      { match: 'return "INCIDENT"', note: "Devolve e encerra a função ali mesmo." },
      { match: 'return "OTHER"', note: "Se nenhuma condição acima devolveu nada, cai aqui: a resposta padrão." },
    ],
    explanation: [
      { id: "word", conceptId: "keyword-match", title: "Uma pista no texto", quick: 'Se o texto contém "down", é INCIDENT.' },
      { id: "default", conceptId: "default-category", title: "Uma resposta padrão", quick: "Quando nenhuma pista aparece, a resposta é OTHER — nunca ficamos sem resposta." },
    ],
    instructions: 'Mude a sua `classify`: `"INCIDENT"` só quando o texto mencionar "down"; qualquer outro texto → `"OTHER"`.',
    expose: ["classify"],
    tests: T(
      "classify",
      `test('"production down" → INCIDENT', () => expect(classify("production down")).toBe("INCIDENT"));
test('"the server is down again" → INCIDENT', () => expect(classify("the server is down again")).toBe("INCIDENT"));
test('"lunch menu" → OTHER', () => expect(classify("lunch menu")).toBe("OTHER"));
test("texto vazio → OTHER", () => expect(classify("")).toBe("OTHER"));`,
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
    examples: [{ expr: 'classify("Production DOWN")', equals: '"INCIDENT"' }],
    minutes: 1,
    introduces: ["text-normalization"],
    prerequisites: ["keyword-match"],
    arch: ARCH_TEXT,
    program: P3,
    lineNotes: [
      { match: "toLowerCase", note: "Uma cópia do texto toda em minúsculas." },
      { match: 'lower.includes("down")', note: "A pergunta agora é feita à cópia em minúsculas." },
    ],
    explanation: [
      { id: "lower", conceptId: "text-normalization", title: "Normalizar uma vez", quick: 'Convertemos o texto para minúsculas antes de procurar. Assim só precisamos procurar "down".' },
    ],
    instructions: 'Faça "down" ser reconhecido com qualquer combinação de maiúsculas e minúsculas.',
    expose: ["classify"],
    tests: T(
      "classify",
      `test('"Production DOWN" → INCIDENT', () => expect(classify("Production DOWN")).toBe("INCIDENT"));
test('"Server Down" → INCIDENT', () => expect(classify("Server Down")).toBe("INCIDENT"));
test('"production down" → INCIDENT', () => expect(classify("production down")).toBe("INCIDENT"));
test('"Lunch Menu" → OTHER', () => expect(classify("Lunch Menu")).toBe("OTHER"));`,
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
    examples: [{ expr: 'classify({ title: "Checkout", description: "the site is down" })', equals: '"INCIDENT"' }],
    minutes: 1,
    introduces: ["ticket-input"],
    prerequisites: ["text-normalization"],
    arch: ARCH_TICKET,
    program: P4,
    lineNotes: [
      { match: "ticket: {", note: "O parâmetro agora é um objeto com dois campos: title e description." },
      { match: 'ticket.title + " " + ticket.description', note: "Junta título e descrição (com um espaço no meio) e procura nos dois de uma vez." },
    ],
    explanation: [
      {
        id: "ticket",
        conceptId: "ticket-input",
        title: "Um ticket é um objeto",
        quick: "`ticket.title` e `ticket.description` são os dois campos. Juntamos os dois e o resto continua igual.",
        normal: "`{ title: string; description: string }` descreve o formato do objeto que entra. No projeto real, esse formato ganha um nome: `TicketInput`.",
      },
    ],
    instructions: 'Agora `classify` recebe um ticket com `title` e `description`. "down" pode aparecer em qualquer um dos dois.',
    expose: ["classify"],
    tests: T(
      "classify",
      `test('"down" na descrição → INCIDENT', () => expect(classify({ title: "Checkout", description: "the site is down" })).toBe("INCIDENT"));
test('"DOWN" no título → INCIDENT', () => expect(classify({ title: "Site DOWN", description: "" })).toBe("INCIDENT"));
test('sem "down" → OTHER', () => expect(classify({ title: "Lunch", description: "menu for friday" })).toBe("OTHER"));`,
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
    examples: [
      { expr: 'classify({ title: "Checkout bug", description: "" })', equals: '"BUG"' },
      { expr: 'classify({ title: "Cannot login", description: "" })', equals: '"ACCESS"' },
      { expr: 'classify({ title: "Login bug", description: "" })', equals: '"BUG"' },
    ],
    minutes: 1,
    introduces: ["ordered-checks"],
    prerequisites: ["ticket-input", "default-category"],
    arch: ARCH_TICKET,
    program: P5,
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
    instructions: 'Reconheça também "bug" → `"BUG"` e "login" → `"ACCESS"`, verificando nesta ordem: down, bug, login.',
    expose: ["classify"],
    tests: T(
      "classify",
      `${TICKETS}
test('"Checkout bug" → BUG', () => expect(t("Checkout bug")).toBe("BUG"));
test('"Cannot LOGIN" → ACCESS', () => expect(t("Cannot LOGIN")).toBe("ACCESS"));
test('"Site down" → INCIDENT', () => expect(t("Site down")).toBe("INCIDENT"));
test('"Login bug" → BUG (a ordem decide)', () => expect(t("Login bug")).toBe("BUG"));
test("nenhuma pista → OTHER", () => expect(t("Lunch", "menu")).toBe("OTHER"));`,
    ),
    toolbox: [tool.if],
    limitation: "Cada categoria nova é mais um `if` — e cada categoria real tem **várias** palavras. A função vai virar uma parede de ifs.",
  },
  {
    slug: "06-rules-as-data",
    title: "Regras como dados",
    subtitle: "Uma tabela no lugar dos ifs",
    goal: "Separar as regras (dados) do mecanismo que as aplica.",
    problem: "Cada palavra nova exige mais um `if`. E se as regras fossem uma **lista**, e a função só percorresse essa lista?",
    examples: [
      { expr: 'classify({ title: "Cannot login", description: "" })', equals: '"ACCESS"' },
      { expr: 'classify({ title: "Login bug", description: "" })', equals: '"BUG"' },
    ],
    minutes: 2,
    introduces: ["rules-as-data"],
    prerequisites: ["ordered-checks"],
    arch: ARCH_RULES,
    program: P6,
    lineNotes: [
      { match: "const RULES", note: "As três regras dos ifs, agora como dados: cada item diz qual palavra leva a qual categoria." },
      { match: "for (const rule of RULES)", note: "Percorre a lista em ordem — a mesma ordem das perguntas de antes." },
      { match: "lower.includes(rule.word)", note: "Os três ifs viraram um só: a palavra vem da regra, não do código." },
    ],
    explanation: [
      { id: "data", conceptId: "rules-as-data", title: "A tabela manda", quick: "Acrescentar uma regra agora é acrescentar uma linha em `RULES`. A função não muda." },
    ],
    instructions: "Troque os ifs por uma lista `RULES` de `{ word, category }` (as mesmas três regras, na mesma ordem) que `classify` percorre. O comportamento não muda.",
    expose: ["classify", "RULES"],
    tests: T(
      "classify, RULES",
      `${TICKETS}
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
    ),
    toolbox: [tool.array, tool.forOf],
    limitation: '**"Outage in EU"** e **"Wrong password"** viram OTHER: faltam palavras na tabela.',
  },
  {
    slug: "07-more-signals",
    title: "Mais pistas",
    subtitle: "Só dados mudam",
    goal: "Ver a tabela pagar o seu custo: mais regras, nenhuma mudança na função.",
    problem: 'Cada categoria tem mais de uma pista: "outage" também é incidente, "error" também é bug, "password" também é acesso.',
    examples: [
      { expr: 'classify({ title: "Outage in EU", description: "" })', equals: '"INCIDENT"' },
      { expr: 'classify({ title: "Wrong password", description: "" })', equals: '"ACCESS"' },
    ],
    minutes: 1,
    introduces: [],
    prerequisites: ["rules-as-data"],
    arch: ARCH_RULES,
    program: P7,
    lineNotes: [{ match: '"outage"', note: "Uma linha nova na tabela. `classify` continua exatamente igual." }],
    explanation: [
      { id: "payoff", conceptId: "rules-as-data", title: "Só a tabela cresceu", quick: "Três pistas novas, zero linhas novas na função. É para isso que a tabela existe." },
    ],
    instructions: "Acrescente à tabela as pistas outage → INCIDENT, error → BUG e password → ACCESS.",
    expose: ["classify", "RULES"],
    tests: T(
      "classify, RULES",
      `${TICKETS}
test("outage → INCIDENT", () => expect(t("Outage in EU")).toBe("INCIDENT"));
test("error → BUG", () => expect(t("Checkout error")).toBe("BUG"));
test("password → ACCESS", () => expect(t("Wrong password")).toBe("ACCESS"));
test("seis pistas, duas por categoria", () => {
  expect(RULES.length).toBe(6);
  expect(RULES.filter((r) => r.category === "INCIDENT").length).toBe(2);
});`,
    ),
    toolbox: [tool.push],
    limitation: 'Ticket: **"Cannot login after password reset — the page shows a bug"**. Há duas pistas de ACCESS e uma de BUG, mas a primeira regra que casa vence: BUG.',
  },
  {
    slug: "08-count-evidence",
    title: "Contar evidências",
    subtitle: "Quantas pistas cada categoria tem?",
    goal: "Medir quantas pistas de uma categoria aparecem no texto.",
    problem: "Em vez de parar na primeira pista, queremos **contar** as pistas de cada categoria.\n\nPrimeiro só medir; decidir vem depois.",
    examples: [
      { expr: 'scoreCategory("ACCESS", "cannot login after password reset")', equals: "2" },
      { expr: 'scoreCategory("BUG", "cannot login after password reset")', equals: "0" },
    ],
    minutes: 2,
    introduces: ["evidence-score"],
    prerequisites: ["rules-as-data"],
    arch: ARCH_SCORE,
    program: P8,
    lineNotes: [
      { match: "function scoreCategory", note: "Uma função nova, ao lado de `classify`: mede, não decide." },
      { match: "let score = 0", note: "Começa sem pontos." },
      { match: "rule.category === category && text.includes(rule.word)", note: "Só conta regras da categoria perguntada, e só se a palavra aparece no texto." },
      { match: "score += 1", note: "Cada pista encontrada vale um ponto." },
    ],
    explanation: [
      { id: "score", conceptId: "evidence-score", title: "Um placar por categoria", quick: "`scoreCategory` percorre as regras e soma 1 para cada palavra daquela categoria que aparece no texto." },
    ],
    instructions: "Crie `scoreCategory(category, text)`: quantas regras de `RULES` daquela categoria aparecem no texto. `classify` ainda não muda.",
    expose: ["scoreCategory", "classify"],
    tests: T(
      "scoreCategory",
      `test("duas pistas de ACCESS", () => expect(scoreCategory("ACCESS", "cannot login after password reset")).toBe(2));
test("nenhuma pista de BUG", () => expect(scoreCategory("BUG", "cannot login after password reset")).toBe(0));
test("duas pistas de BUG", () => expect(scoreCategory("BUG", "error: bug found")).toBe(2));
test("texto vazio → 0", () => expect(scoreCategory("INCIDENT", "")).toBe(0));`,
    ),
    toolbox: [tool.counter, tool.and],
    limitation: "Temos o placar de cada categoria, mas `classify` ainda escolhe pela primeira regra que casa.",
  },
  {
    slug: "09-compare-two",
    title: "Comparar dois placares",
    subtitle: "ACCESS × BUG",
    goal: "Usar o placar para decidir entre duas categorias.",
    problem: 'No ticket "Cannot login after password reset — the page shows a bug", ACCESS tem 2 pistas e BUG tem 1. Com `scoreCategory` em mãos, dá para **comparar** os dois placares.',
    examples: [{ expr: 'classify({ title: "Cannot login", description: "after password reset the page shows a bug" })', equals: '"ACCESS"' }],
    minutes: 1,
    introduces: ["compare-scores"],
    prerequisites: ["evidence-score"],
    arch: ARCH_PICK,
    program: P9,
    lineNotes: [
      { match: 'scoreCategory("ACCESS", lower) > scoreCategory("BUG", lower)', note: "Dois placares, uma comparação: quem tem mais pistas?" },
      { match: 'return "ACCESS"', note: "ACCESS venceu a comparação. O resto da função continua igual para os outros casos." },
    ],
    explanation: [
      { id: "compare", conceptId: "compare-scores", title: "Mais pistas vence", quick: "Em vez da primeira regra que casa, comparamos quantas pistas cada categoria tem." },
    ],
    instructions: 'Antes de percorrer as regras, faça `classify` devolver `"ACCESS"` quando ACCESS tiver mais pistas que BUG.',
    expose: ["classify", "scoreCategory"],
    tests: T(
      "classify",
      `${TICKETS}
test("ACCESS 2 × BUG 1 → ACCESS", () => expect(t("Cannot login", "after password reset the page shows a bug")).toBe("ACCESS"));
test("o resto continua igual", () => {
  expect(t("Site down")).toBe("INCIDENT");
  expect(t("Checkout bug")).toBe("BUG");
  expect(t("Lunch", "menu")).toBe("OTHER");
});`,
    ),
    toolbox: [tool.compare],
    limitation: 'Ticket **"Checkout down"**, descrição "error: bug found": BUG tem 2 pistas e INCIDENT 1, mas vence INCIDENT. E um `if` para cada par de categorias não escala.',
  },
  {
    slug: "10-best-so-far",
    title: "Percorrer todas as categorias",
    subtitle: "A melhor até agora",
    goal: "Comparar todas as categorias, não só um par.",
    problem: "Comparar par a par não escala: com 3 categorias já são 3 comparações; com as 7 do projeto real, 21. E se percorrêssemos as categorias guardando **a melhor até agora**?",
    examples: [
      { expr: 'classify({ title: "Checkout down", description: "error: bug found" })', equals: '"BUG"' },
      { expr: 'classify({ title: "Lunch", description: "menu" })', equals: '"OTHER"' },
    ],
    minutes: 2,
    introduces: ["highest-score"],
    prerequisites: ["compare-scores", "default-category"],
    arch: ARCH_PICK,
    program: P10,
    lineNotes: [
      { match: "const CATEGORIES", note: "As categorias que disputam. A ordem importa só em empate." },
      { match: 'let best = "OTHER"', note: 'Começa em OTHER. OTHER não tem regras, então o placar dele é 0: se ninguém pontuar, é a resposta.' },
      { match: "scoreCategory(category, lower) > scoreCategory(best, lower)", note: "A mesma comparação da etapa anterior, agora entre a categoria da vez e a melhor até agora." },
      { match: "best = category", note: "Achou uma melhor: ela vira a melhor até agora. Só troca se for estritamente maior — em empate, fica quem veio antes." },
    ],
    explanation: [
      { id: "max", conceptId: "highest-score", title: "Guardar a melhor até agora", quick: "Percorre as categorias e troca a melhor sempre que aparece uma com mais pistas. Ninguém pontuou → OTHER. Empate → vence a que veio primeiro." },
    ],
    instructions: 'Troque a comparação ACCESS × BUG e o laço de regras por um laço sobre as categorias (INCIDENT, BUG, ACCESS) que guarda a de maior placar. Nenhuma pista → `"OTHER"`; empate → a que vem primeiro.',
    expose: ["classify", "scoreCategory"],
    tests: T(
      "classify",
      `${TICKETS}
test("BUG 2 × INCIDENT 1 → BUG", () => expect(t("Checkout down", "error: bug found")).toBe("BUG"));
test("ACCESS 2 × BUG 1 → ACCESS", () => expect(t("Cannot login", "after password reset the page shows a bug")).toBe("ACCESS"));
test("nenhuma pista → OTHER", () => expect(t("Lunch", "menu")).toBe("OTHER"));
test("empate → a primeira da ordem (INCIDENT antes de BUG)", () => expect(t("bug", "outage")).toBe("INCIDENT"));`,
    ),
    toolbox: [tool.forOf, tool.max],
    limitation: 'Título **"Cannot login"**, descrição "maybe a bug": 1 × 1, e o empate dá BUG. Mas quem abriu o ticket resumiu o problema no título — ele deveria pesar mais.',
  },
  {
    slug: "11-title-weight",
    title: "O título pesa o dobro",
    subtitle: "Onde a pista aparece importa",
    goal: "Dar mais peso a pistas no título do que na descrição.",
    problem: "O título é onde a pessoa resume o problema. Uma pista ali deveria valer **mais** do que a mesma pista perdida na descrição.",
    examples: [
      { expr: 'scoreCategory("BUG", "bug in checkout", "")', equals: "2" },
      { expr: 'scoreCategory("BUG", "", "bug in checkout")', equals: "1" },
    ],
    minutes: 2,
    introduces: ["title-weight"],
    prerequisites: ["evidence-score", "highest-score"],
    arch: ARCH_PICK,
    program: P11,
    lineNotes: [
      { match: "title.includes(rule.word)", note: "Pista no título…" },
      { match: "score += 2", note: "…vale 2 pontos." },
      { match: "description.includes(rule.word)", note: "Pista na descrição continua valendo 1. A mesma palavra nos dois lugares soma 3." },
      { match: "const title = ticket.title.toLowerCase()", note: "`classify` normaliza título e descrição separadamente, para o placar saber onde cada pista estava." },
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
    instructions: "Faça `scoreCategory` receber `category, title, description`: pista no título vale 2, na descrição vale 1. Ajuste `classify` para passar os dois separados.",
    expose: ["classify", "scoreCategory"],
    tests: T(
      "classify, scoreCategory",
      `test("pista no título vale 2", () => expect(scoreCategory("BUG", "bug in checkout", "")).toBe(2));
test("pista na descrição vale 1", () => expect(scoreCategory("BUG", "", "bug in checkout")).toBe(1));
test("título e descrição somam", () => expect(scoreCategory("ACCESS", "cannot login", "password reset")).toBe(3));
test("classify usa o novo placar: título vence", () => expect(classify({ title: "Cannot login", description: "maybe a bug" })).toBe("ACCESS"));`,
    ),
    toolbox: [tool.and, tool.counter],
    limitation: '"error" aparece em quase todo ticket; "down" é quase certeza de incidente. Hoje **as duas pistas valem o mesmo**.',
  },
  {
    slug: "12-signal-weights",
    title: "Sinais fortes e fracos",
    subtitle: "Cada pista tem um peso",
    goal: "Dar a cada pista uma força diferente.",
    problem: 'Uma pista forte ("down") deveria valer mais que uma fraca ("error"). Onde guardar essa força?',
    examples: [
      { expr: 'scoreCategory("BUG", "error", "")', equals: "2" },
      { expr: 'scoreCategory("INCIDENT", "", "outage")', equals: "4" },
    ],
    minutes: 2,
    introduces: ["weighted-signals"],
    prerequisites: ["title-weight", "rules-as-data"],
    arch: ARCH_PICK,
    program: P12,
    lineNotes: [
      { match: "weight: 5", note: '"down" é a pista mais forte de incidente.' },
      { match: "weight: 1", note: '"error" aparece em todo lugar: pista fraca.' },
      { match: "rule.weight * 2", note: "O peso da pista, dobrado no título." },
      { match: "score += rule.weight;", note: "O peso da pista, simples na descrição." },
    ],
    explanation: [
      { id: "weights", conceptId: "weighted-signals", title: "A força mora na tabela", quick: "Cada regra ganhou `weight`. O placar soma o peso (dobrado no título) em vez de 2 e 1." },
    ],
    instructions: "Dê a cada regra um `weight`: down 5, outage 4, bug 3, error 1, login 4, password 2. No título a pista vale o dobro do peso; na descrição, o peso.",
    expose: ["classify", "scoreCategory"],
    tests: T(
      "scoreCategory",
      `test("pista fraca no título: 1 × 2", () => expect(scoreCategory("BUG", "error", "")).toBe(2));
test("pista fraca na descrição: 1", () => expect(scoreCategory("BUG", "", "error")).toBe(1));
test("pista forte na descrição: 4", () => expect(scoreCategory("INCIDENT", "", "outage")).toBe(4));
test("soma de pistas e posições", () => expect(scoreCategory("INCIDENT", "down", "outage")).toBe(14));
test("login e password", () => expect(scoreCategory("ACCESS", "login", "password")).toBe(10));`,
    ),
    toolbox: [tool.counter],
    limitation: 'Descrição **"login fails with a bug error"**: ACCESS 4 × BUG 4. O empate cai para quem vem primeiro em `CATEGORIES` — uma ordem que ninguém escolheu de propósito.',
    noveltyException:
      "6 das 8 linhas são a mesma edição mecânica na tabela (acrescentar `weight` a cada regra); a ideia é uma só. Separar dados e uso criaria uma etapa sem mudança de comportamento.",
  },
  {
    slug: "13-safe-tie-break",
    title: "Empate seguro",
    subtitle: "A ordem vira uma decisão",
    goal: "Decidir, de propósito, quem vence um empate.",
    problem: "Em empate, qual erro é mais caro? Tratar um incidente como bug deixa produção fora do ar esperando na fila. Tratar um bug como incidente custa alguns minutos de atenção.",
    examples: [{ expr: 'classify({ title: "", description: "login fails with a bug error" })', equals: '"ACCESS"' }],
    minutes: 1,
    introduces: ["tie-break"],
    prerequisites: ["highest-score"],
    arch: ARCH_TIE,
    program: P13,
    lineNotes: [
      { match: "const TIE_BREAK", note: "A mesma lista de antes, com nome e ordem escolhidos: incidentes, depois acesso, depois bug." },
      { match: "for (const category of TIE_BREAK)", note: "Como só troca com placar estritamente maior, a primeira da lista vence os empates." },
    ],
    explanation: [
      { id: "tie", conceptId: "tie-break", title: "Errar para o lado seguro", quick: "A lista `TIE_BREAK` torna explícita uma decisão de produto: em empate, INCIDENT > ACCESS > BUG." },
    ],
    instructions: "Em empate, a ordem passa a ser INCIDENT, ACCESS, BUG.",
    expose: ["classify", "scoreCategory"],
    tests: T(
      "classify",
      `${TICKETS}
test("empate ACCESS × BUG → ACCESS", () => expect(t("", "login fails with a bug error")).toBe("ACCESS"));
test("empate INCIDENT × ACCESS → INCIDENT", () => expect(t("", "outage login")).toBe("INCIDENT"));
test("sem empate, maior placar vence", () => expect(t("Checkout bug", "")).toBe("BUG"));
test("nada → OTHER", () => expect(t("Lunch", "menu")).toBe("OTHER"));`,
    ),
    toolbox: [tool.max],
    limitation: '**"Debug mode is slow"** virou BUG: "bug" está dentro de "debug". `includes` procura pedaços, não palavras.',
  },
  {
    slug: "14-whole-words",
    title: "Palavra inteira",
    subtitle: '"debug" não é "bug"',
    goal: "Fazer cada pista casar só com a palavra inteira.",
    problem: '"debug" contém "bug"; "downloads" contém "down". Precisamos casar a **palavra**, não um pedaço dela.',
    examples: [
      { expr: 'scoreCategory("BUG", "debug mode is slow", "")', equals: "0" },
      { expr: 'scoreCategory("INCIDENT", "", "downloads are slow")', equals: "0" },
      { expr: 'scoreCategory("BUG", "bug in checkout", "")', equals: "6" },
    ],
    minutes: 2,
    introduces: ["regex-word-boundary"],
    prerequisites: ["weighted-signals"],
    arch: ARCH_TIE,
    program: P14,
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
    instructions: 'Faça cada pista casar só com a palavra inteira: "debug" não é "bug", "downloads" não é "down". Mesmas pistas, categorias e pesos.',
    expose: ["classify", "scoreCategory"],
    tests: T(
      "classify, scoreCategory",
      `test('"debug" não conta como "bug"', () => expect(scoreCategory("BUG", "debug mode is slow", "")).toBe(0));
test('"downloads" não conta como "down"', () => expect(scoreCategory("INCIDENT", "", "downloads are slow")).toBe(0));
test("bug no título: 3 × 2", () => expect(scoreCategory("BUG", "bug in checkout", "")).toBe(6));
test("login e password na descrição: 4 + 2", () => expect(scoreCategory("ACCESS", "", "login after password reset")).toBe(6));
test("classify: debug mode → OTHER", () => expect(classify({ title: "Debug mode is slow", description: "" })).toBe("OTHER"));`,
    ),
    toolbox: [tool.regex, tool.boundary],
    limitation: 'As categorias são strings soltas. Um **"INCIDNET"** digitado errado passaria em silêncio — e aquela categoria nunca mais seria escolhida.',
    noveltyException:
      "6 das 8 linhas são a mesma troca mecânica na tabela (`word: \"bug\"` → `pattern: /\\bbug\\b/`); a ideia é uma só. Tratar só parte das regras exigiria código para dois formatos de regra ao mesmo tempo.",
  },
  {
    slug: "15-category-enum",
    title: "Um conjunto fechado",
    subtitle: "enum Category",
    goal: "Declarar as categorias possíveis como um conjunto fechado e verificado.",
    problem: 'Hoje qualquer string passa por categoria. Queremos um conjunto **fechado** — INCIDENT, BUG, ACCESS, OTHER — em que um erro de digitação seja **recusado antes de o código rodar**: `const c: Category = "INCIDNET"` tem que ser um erro.',
    examples: [{ expr: "Category.ACCESS", equals: '"ACCESS"' }],
    minutes: 1,
    introduces: ["string-enum"],
    prerequisites: ["tie-break"],
    arch: ARCH_TIE,
    program: P15,
    lineNotes: [
      { match: "enum Category", note: "Declara o conjunto fechado de categorias." },
      { match: 'INCIDENT = "INCIDENT"', note: 'Cada membro tem um nome e um valor. Em runtime, Category.INCIDENT é a própria string "INCIDENT".' },
    ],
    explanation: [
      {
        id: "enum",
        conceptId: "string-enum",
        title: "Nomes em vez de strings soltas",
        quick: '`enum Category` lista as quatro categorias. Algo do tipo `Category` só aceita esses membros: `"INCIDNET"` vira erro de compilação.',
        normal: 'Em runtime nada muda — `Category.BUG === "BUG"`. A diferença acontece **antes** de rodar: nesta etapa o seu código passa pelo verificador do TypeScript, e um tipo errado reprova sem executar nenhum teste.',
      },
    ],
    instructions: 'Declare o `enum Category` com INCIDENT, BUG, ACCESS e OTHER, cada um valendo o próprio nome como texto. Nesta etapa o código passa pelo **verificador do TypeScript** — a aba "verificação de tipos" mostra o que ele exige. Depois de passar, experimente escrever `const c: Category = "BILLIGN";`.',
    expose: ["Category", "classify"],
    typecheck: `import { Category } from "./${FILE}";

// Os quatro membros existem e têm o tipo Category.
export const all: Category[] = [Category.INCIDENT, Category.BUG, Category.ACCESS, Category.OTHER];

// Uma string solta, com erro de digitação, NÃO pode ser uma Category.
// @ts-expect-error
export const typo: Category = "INCIDNET";`,
    tests: T(
      "Category",
      `test("quatro categorias, cada uma valendo o próprio nome", () => {
  expect([Category.INCIDENT, Category.BUG, Category.ACCESS, Category.OTHER]).toEqual(["INCIDENT", "BUG", "ACCESS", "OTHER"]);
});`,
    ),
    toolbox: [tool.enumT],
    limitation: "O enum existe, mas o programa ainda não o usa: `classify` devolve `string`, e nada a impede de devolver \"INCIDNET\".",
  },
  {
    slug: "16-classify-returns-category",
    title: "classify devolve Category",
    subtitle: "A resposta vem do conjunto",
    goal: "Fazer o TypeScript garantir que classify só devolve categorias válidas.",
    problem: "`classify` ainda promete devolver qualquer `string`. Queremos que a promessa seja `Category` — e que o verificador a cobre.",
    examples: [{ expr: 'classify({ title: "Cannot login", description: "" })', equals: "Category.ACCESS" }],
    minutes: 1,
    introduces: [],
    prerequisites: ["string-enum"],
    arch: ARCH_ENUM,
    program: P16,
    lineNotes: [
      { match: "TIE_BREAK = [Category.", note: "A ordem de desempate passa a usar os membros do enum." },
      { match: "): Category {", note: "`classify` promete devolver uma `Category` — o TypeScript confere." },
      { match: "let best = Category.OTHER", note: "O padrão também é um membro do enum." },
    ],
    explanation: [
      { id: "returns", conceptId: "string-enum", title: "A promessa no tipo de retorno", quick: "Com `: Category` no retorno, devolver uma string solta vira erro de compilação — antes de qualquer teste." },
    ],
    instructions: "Faça `classify` devolver `Category` (e use o enum na ordem de desempate e na resposta padrão).",
    expose: ["Category", "classify"],
    typecheck: `import { Category, classify } from "./${FILE}";

// classify devolve uma Category.
export const decided: Category = classify({ title: "Server down", description: "" });`,
    tests: T(
      "Category, classify",
      `test("classify devolve membros de Category", () => {
  expect(classify({ title: "Cannot login", description: "" })).toBe(Category.ACCESS);
  expect(classify({ title: "Lunch", description: "" })).toBe(Category.OTHER);
});`,
    ),
    toolbox: [tool.enumT],
    limitation: 'A tabela ainda usa strings soltas: um `category: "INCIDNET"` ali continuaria passando sem aviso.',
  },
  {
    slug: "17-rules-use-enum",
    title: "A tabela usa os nomes",
    subtitle: "Nenhuma string solta",
    goal: "Levar a verificação de tipos até a tabela de regras.",
    problem: "O enum existe e `classify` o usa, mas a tabela ainda escreve as categorias como texto. Um erro de digitação ali escaparia da verificação.",
    examples: [{ expr: "RULES[0].category", equals: "Category.INCIDENT" }],
    minutes: 1,
    introduces: [],
    prerequisites: ["string-enum"],
    arch: ARCH_ENUM,
    program: P17,
    lineNotes: [
      { match: "category: Category.INCIDENT, weight: 5", note: "`Category.INCIDNET` não existe: o TypeScript aponta o erro antes de rodar." },
    ],
    explanation: [
      { id: "enum-table", conceptId: "string-enum", title: "Verificado de ponta a ponta", quick: "Com a tabela usando `Category.X`, nenhuma categoria do programa é mais uma string solta." },
    ],
    instructions: "Faça a tabela `RULES` usar `Category` em vez de strings.",
    expose: ["Category", "classify", "RULES"],
    typecheck: `import { Category, RULES } from "./${FILE}";

// Cada regra aponta para um membro de Category, não para uma string solta.
export const first: Category = RULES[0].category;`,
    tests: T(
      "Category, classify, RULES",
      `test("cada regra usa um membro de Category", () => {
  expect(RULES.map((r) => r.category)).toEqual([Category.INCIDENT, Category.INCIDENT, Category.BUG, Category.BUG, Category.ACCESS, Category.ACCESS]);
});
test("comportamento preservado", () => expect(classify({ title: "", description: "login fails with a bug error" })).toBe(Category.ACCESS));`,
    ),
    toolbox: [tool.enumT],
    limitation: "Você evoluiu cada peça. Consegue montar o classificador inteiro, **do zero, sem olhar**?",
  },
];

// ---------- module checkpoint: the final state, rebuilt from an empty editor ----------
const checkpoint = {
  slug: "99-checkpoint",
  title: "Checkpoint: o classificador inteiro",
  subtitle: "Do zero, sem olhar",
  goal: "Reconstruir sozinho o classificador determinístico completo e compará-lo com o código real.",
  problem: "Juntar todas as peças do módulo em um arquivo, começando do editor vazio. Depois, comparar a sua versão com a versão consolidada do Replay e com o código real do ops-triage-ai.",
  requirements: [
    "`Category`: INCIDENT, BUG, ACCESS, OTHER",
    "Pistas (palavra inteira, sem diferenciar maiúsculas) e pesos: down 5, outage 4 → INCIDENT · bug 3, error 1 → BUG · login 4, password 2 → ACCESS",
    "`scoreCategory(category, title, description)`: no título vale o dobro do peso",
    "`classify(ticket)`: maior placar; empate → INCIDENT, ACCESS, BUG; nenhuma pista → OTHER",
  ],
  minutes: 5,
  prerequisites: ["string-enum", "regex-word-boundary", "tie-break", "weighted-signals", "title-weight"],
  program: P17,
  explanation: [
    {
      id: "real",
      title: "O que o código real faz a mais",
      quick: "O mesmo esqueleto — sinais com peso, título em dobro, desempate explícito — com mais categorias e mais sinais por categoria.",
      normal: 'No `DeterministicTriageClassifier` real, cada sinal também tem um `label` ("production_down") usado para explicar a decisão; `normalize` remove acentos e pontuação; e o resultado não é só a categoria: inclui confiança, prioridade, risco e time sugerido. Esses são os próximos módulos.',
    },
  ],
  instructions: "Reconstrua em `classify.ts`, do zero: `Category`, as regras, `scoreCategory(category, title, description)` e `classify(ticket)`. Os requisitos estão acima; o resto é com você. O TypeScript verifica os tipos antes dos testes.",
  expose: ["Category", "RULES", "scoreCategory", "classify"],
  typecheck: `import { Category, RULES, classify, scoreCategory } from "./${FILE}";

// classify devolve uma Category; scoreCategory, um número; a tabela usa Category.
export const decided: Category = classify({ title: "Server down", description: "" });
export const points: number = scoreCategory(Category.BUG, "bug", "");
export const first: Category = RULES[0].category;

// Uma string solta não é uma Category.
// @ts-expect-error
export const typo: Category = "INCIDNET";`,
  tests: T(
    "Category, classify, scoreCategory",
    `${TICKETS}
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
test("sem pistas → OTHER", () => expect(t("Lunch", "menu")).toBe(Category.OTHER));`,
  ),
  toolbox: [tool.enumT, tool.regex, tool.boundary, tool.forOf, tool.max, tool.lower],
  originalCodeRefs: [
    { path: "src/domain/triage.ts", startLine: 1, endLine: 9, symbol: "Category", replayFile: FILE, note: "O mesmo enum, com 7 categorias (inclui FEATURE_REQUEST, CONTENT_CHANGE e SUPPORT). Mora na camada de domínio." },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 24, endLine: 66, symbol: "CATEGORY_SIGNALS", replayFile: FILE, replaySymbol: "RULES", note: "Nossa tabela RULES, organizada por categoria (Record<Category, ...>), com vários sinais por categoria e um label por sinal para explicar a decisão." },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 68, endLine: 77, symbol: "CATEGORY_TIE_BREAK", replayFile: FILE, note: 'Nosso TIE_BREAK, com o mesmo raciocínio no comentário: "Safety-sensitive operational categories win."' },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 116, endLine: 132, symbol: "scoreCategory", replayFile: FILE, note: "Idêntico em lógica: peso × 2 no título, peso na descrição. Também devolve quais sinais casaram (matched)." },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 78, endLine: 114, symbol: "classify", replayFile: FILE, note: "Nosso classify guarda só a melhor categoria e recalcula o placar dela; o real guarda o placar de todas (scores, highestScore, leaders) porque também precisa do 2º colocado para a confiança — além de prioridade, risco, time sugerido e justificativa." },
    { path: "src/application/classifiers/deterministic-triage-classifier.ts", startLine: 221, endLine: 229, symbol: "normalize", replayFile: FILE, replaySymbol: "classify", note: "Nosso toLowerCase, mais remoção de acentos e pontuação." },
  ],
  checkpointQuestion: {
    question: "No código real, por que o título ter peso dobrado é uma decisão que precisa ser medida, e não uma verdade?",
    answer: "Porque é uma hipótese sobre como as pessoas escrevem tickets. O projeto real avalia o classificador em datasets rotulados: se dobrar o título piorasse os acertos, o peso mudaria. Os pesos são parâmetros de produto, não fatos.",
  },
};

// ---------- write ----------
rmSync(ROOT, { recursive: true, force: true });

function writeStage(slug: string, json: Record<string, unknown>, program: string, tests: string, typecheck?: string): void {
  const dir = join(ROOT, slug);
  mkdirSync(join(dir, "reference"), { recursive: true });
  writeFileSync(join(dir, "reference", FILE), program + "\n");
  writeFileSync(join(dir, "tests.ts"), tests);
  if (typecheck) {
    mkdirSync(join(dir, "given"), { recursive: true });
    writeFileSync(join(dir, "given", "check.ts"), typecheck + "\n");
  }
  writeFileSync(join(dir, "stage.json"), JSON.stringify(json, null, 2) + "\n");
}

const exercise = (instructions: string, expose: string[], typecheck?: string) => ({
  instructions,
  files: [FILE],
  expose,
  ...(typecheck ? { typecheck: { files: ["check.ts"] } } : {}),
});

for (const step of steps) {
  writeStage(
    step.slug,
    {
      kind: "micro",
      title: step.title,
      subtitle: step.subtitle,
      goal: step.goal,
      problem: step.problem,
      examples: step.examples,
      estimatedMinutes: step.minutes,
      introduces: step.introduces,
      prerequisites: step.prerequisites,
      architecture: step.arch,
      referenceCode: [FILE],
      lineNotes: step.lineNotes,
      explanation: step.explanation,
      exercise: exercise(step.instructions, step.expose, step.typecheck),
      toolbox: step.toolbox,
      ...(step.limitation ? { limitation: step.limitation } : {}),
      ...(step.noveltyException ? { noveltyException: step.noveltyException } : {}),
    },
    step.program,
    step.tests,
    step.typecheck,
  );
}

writeStage(
  checkpoint.slug,
  {
    kind: "checkpoint",
    title: checkpoint.title,
    subtitle: checkpoint.subtitle,
    goal: checkpoint.goal,
    problem: checkpoint.problem,
    requirements: checkpoint.requirements,
    estimatedMinutes: checkpoint.minutes,
    introduces: [],
    prerequisites: checkpoint.prerequisites,
    architecture: ARCH_ENUM,
    referenceCode: [FILE],
    explanation: checkpoint.explanation,
    originalCodeRefs: checkpoint.originalCodeRefs,
    exercise: exercise(checkpoint.instructions, checkpoint.expose, checkpoint.typecheck),
    toolbox: checkpoint.toolbox,
    checkpoint: checkpoint.checkpointQuestion,
  },
  checkpoint.program,
  checkpoint.tests,
  checkpoint.typecheck,
);

console.log([...steps.map((s) => s.slug), checkpoint.slug].map((slug) => `m1/${slug}`).join("\n"));
