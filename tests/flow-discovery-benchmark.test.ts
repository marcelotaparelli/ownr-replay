import { test, expect } from "bun:test";
import { declarationsOf, type RepositoryIndex } from "../src/services/code-map.ts";
import { discoverFlow } from "../src/services/flow-discovery.ts";
import { BenchmarkSchema, matchesGold } from "../scripts/benchmark-flow-discovery.ts";

/**
 * Two things, both diagnostic. (1) benchmarks/flow-discovery.json stays a coherent record of the 15-repository
 * coverage benchmark. (2) For every limitation seen in at least two failing repositories, the smallest source that
 * isolates it, as a pair: the shape discovery follows today and the near-identical shape it does not. They pin
 * CURRENT behaviour, they do not endorse it: when a limit is lifted the matching "does not" assertion is expected
 * to flip. Each pair was also lifted alone on the real repositories (scratchpad, product untouched); see the
 * benchmark's `walls` for which repositories each limit blocks.
 */

const indexOf = (files: Record<string, string>): RepositoryIndex => ({
  files: new Map(Object.entries(files)),
  declarations: Object.entries(files).flatMap(([path, content]) => declarationsOf(path, content)),
});
const names = (chain: { symbol: string; container: string | null }[]): string[] => chain.map((node) => (node.container ? `${node.container}.${node.symbol}` : node.symbol));
const GOAL = "Quero entender como um pagamento é criado.";
const ARTICLE_SERVICE = `
export class PaymentsService {
  create(dto: Dto) {
    return dto;
  }
}
`;

// ---- the record --------------------------------------------------------------------------------------

const benchmark = BenchmarkSchema.parse(await Bun.file(new URL("../benchmarks/flow-discovery.json", import.meta.url)).json());
const KNOWN_WALLS = new Set([
  "entry-shape", "decl-extent", "callable-detection", "generic-call", "ctor-first-paren", "decorated-ctor-params", "name-relevance",
  "construction-as-call", "class-field-type", "fork-drop", "computed-type", "module-object-receiver", "inferred-local-type",
  "dynamic-dispatch", "callback-param-type", "inheritance", "external-function-boundary",
]);

test("benchmark: 15 repositórios distintos, cada falha com primeira causa e paredes conhecidas", () => {
  const { repos } = benchmark;
  expect(repos).toHaveLength(15);
  expect(new Set(repos.map((r) => r.id)).size).toBe(15);
  expect(new Set(repos.map((r) => r.repo.toLowerCase())).size).toBe(15);
  for (const r of repos) {
    if (r.outcome === "success") {
      expect(r.firstCause).toBeUndefined();
      continue;
    }
    expect(r.walls?.[0]).toBe(r.firstCause);
    for (const wall of r.walls ?? []) expect(KNOWN_WALLS.has(wall)).toBe(true);
  }
  expect(repos.filter((r) => r.outcome === "success").map((r) => r.id)).toEqual(["O1", "R1"]);
});

test("benchmark: matchesGold exige todos os padrões, em ordem, sobre path#Container.símbolo", () => {
  const chain = [
    { path: "a/controller.ts", container: "C", symbol: "create" },
    { path: "a/service.ts", container: "S", symbol: "create" },
  ];
  expect(matchesGold(chain, ["C\\.create", "S\\.create"])).toBe(true);
  expect(matchesGold(chain, ["S\\.create", "C\\.create"])).toBe(false);
  expect(matchesGold(chain, ["service\\.ts#S\\.create"])).toBe(true);
  expect(matchesGold(chain.slice(0, 1), ["C\\.create", "S\\.create"])).toBe(false);
});

// ---- entry-shape (R2, R5, R6, O4): trace_request only knows `(request: Request) => Response` ----------

test("entry-shape: trace_request segue handler Fetch API exportado", () => {
  const index = indexOf({
    "handler.ts": `
export function handle(request: Request): Response {
  return createPayment(request);
}
function createPayment(request: Request): Response {
  return storePayment(request);
}
function storePayment(request: Request): Response {
  return new Response("ok");
}
`,
  });
  expect(names(discoverFlow(GOAL, index, "trace_request").chain)).toEqual(["handle", "createPayment", "storePayment"]);
});

test("entry-shape: o mesmo fluxo com handler (req, res) de Express/Fastify não tem ponto de entrada", () => {
  const index = indexOf({
    "handler.ts": `
export function handle(req: Req, res: Res) {
  return createPayment(req, res);
}
function createPayment(req: Req, res: Res) {
  return storePayment(req, res);
}
function storePayment(req: Req, res: Res) {
  return res.send("ok");
}
`,
  });
  expect(() => discoverFlow(GOAL, index, "trace_request")).toThrow(/Nenhum ponto de entrada HTTP/);
});

// ---- decl-extent (R2, R3): a `{ ... }` inside the parameter list ends the declaration early ------------

test("decl-extent: assinatura em linha única mantém o corpo dentro da declaração", () => {
  const source = `export async function register(request: Req, reply: Reply) {
  return createUser(request.body);
}
`;
  const [declaration] = declarationsOf("controller.ts", source);
  expect(declaration?.endLine).toBe(3);
});

test("decl-extent: tipo-objeto ou desestruturação na lista de parâmetros encerra a declaração antes do corpo", () => {
  const source = `export async function register(
  request: Req<{
    Body: Input;
  }>,
  reply: Reply
) {
  return createUser(request.body);
}
`;
  const [declaration] = declarationsOf("controller.ts", source);
  // Line 4 is `}>,`: the braces balanced inside the signature, so the body (line 7, the call) is not part of it.
  expect(declaration?.endLine).toBe(4);
});

// ---- callable-detection (R6, R7, O5): only `function` and `const f = (...) =>` on ONE line start a flow -

const callable = (header: string): RepositoryIndex =>
  indexOf({ "payment.ts": `${header}\n  return storePayment(dto);\n}${header.includes("wrap(") ? ")" : ""}\nexport function storePayment(dto: Dto) {\n  return dto;\n}\n` });

test("callable-detection: arrow const de uma linha é ponto de partida", () => {
  const index = callable("export const createPayment = async (dto: Dto) => {");
  expect(names(discoverFlow(GOAL, index, "other").chain)).toEqual(["createPayment", "storePayment"]);
});

test("callable-detection: arrow genérica `<T>(…) =>` ou callback embrulhado em `wrap(…)` não é ponto de partida", () => {
  expect(() => discoverFlow(GOAL, callable("export const createPayment = <T>(dto: T) => {"), "other")).toThrow(/nenhuma chamada comprovada/);
  expect(() => discoverFlow(GOAL, callable("export const createPayment = wrap(async (dto: Dto) => {"), "other")).toThrow(/nenhuma chamada comprovada/);
});

// ---- ctor-first-paren (R8, R9) and decorated-ctor-params (R8, R10): how a class's dependencies are typed

const controller = (members: string): RepositoryIndex =>
  indexOf({
    "controller.ts": `
export class PaymentsController {
${members}
  create(dto: Dto) {
    return this.paymentsService.create(dto);
  }
}
`,
    "service.ts": ARTICLE_SERVICE,
  });
const CTOR = "  constructor(private readonly paymentsService: PaymentsService) {}";

test("ctor-first-paren: dependência injetada no construtor resolve a chamada controller -> service", () => {
  expect(names(discoverFlow(GOAL, controller(CTOR), "other").chain)).toEqual(["PaymentsController.create", "PaymentsService.create"]);
});

test("ctor-first-paren: um campo inicializado com chamada ANTES do construtor (`new Logger(...)`) esconde a dependência", () => {
  const members = `  private readonly logger = new Logger(PaymentsController.name);\n${CTOR}`;
  expect(() => discoverFlow(GOAL, controller(members), "other")).toThrow(/nenhuma chamada comprovada/);
});

test("decorated-ctor-params: o mesmo construtor com `@Inject(TOKEN)` no parâmetro perde o tipo da dependência", () => {
  const members = "  constructor(@Inject(PAYMENTS) private readonly paymentsService: PaymentsService) {}";
  expect(() => discoverFlow(GOAL, controller(members), "other")).toThrow(/nenhuma chamada comprovada/);
});

// ---- construction-as-call (R4, R10, O3): `new X(...)` is an edge to the class, whose body is every method

test("construction-as-call: a cadeia termina no construtor da entidade, não na operação que a persiste", () => {
  const index = indexOf({
    "service.ts": `
export class PaymentsService {
  create(dto: Dto) {
    const payment = new Payment(dto);
    return this.repository.save(payment);
  }
  constructor(private readonly repository: PaymentsRepository) {}
}
export class Payment {
  constructor(readonly dto: Dto) {}
}
`,
  });
  expect(names(discoverFlow(GOAL, index, "other").chain)).toEqual(["PaymentsService.create", "Payment"]);
});
