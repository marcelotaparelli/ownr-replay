import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildAstGraph, FULL_AST, INFERRED_AST, type AstGraph } from "../src/experiments/ast-facts.ts";
import { discoverFlowAst } from "../src/experiments/ast-flow-discovery.ts";

/**
 * The AST spike (src/experiments, NOT product) on one small repository written to disk: every structural capability the
 * regex discovery lacks, and — just as important — what must stay UNPROVEN (dynamic dispatch, two implementations, a package
 * that merely shares a file name with the repository). The regex counterparts of these shapes are pinned in
 * flow-discovery-benchmark.test.ts. Uses the native TypeScript parser through `typescript/unstable/async`.
 */

const FILES: Record<string, string> = {
  "payments/controller.ts": `
import { PaymentsService } from "./service";
export class PaymentsController {
  private readonly logger = new Logger("payments");
  constructor(@Inject(TOKEN) private readonly payments: PaymentsService) {}

  create(dto: Dto) {
    this.logger.log("x");
    return this.payments?.create<number>(dto);
  }
}
`,
  "payments/service.ts": `
import { store } from "./store";
import { Mapper } from "./mapper";
export class PaymentsService {
  create<T>(dto: T) {
    const thing = new Thing(dto);
    Mapper.toDomain(dto);
    return store<T>(dto);
  }
}
`,
  "payments/store.ts": `export function store<T>(dto: T) { return dto; }\n`,
  "payments/mapper.ts": `export class Mapper { static toDomain(dto: unknown) { return dto; } }\n`,
  "http/handlers.ts": `
import { createUser } from "./users";
export async function registerHandler(
  request: FastifyRequest<{
    Body: Input;
  }>,
  reply: FastifyReply
) {
  return createUser(request.body);
}
`,
  "http/users.ts": `export function createUser(body: unknown) { return body; }\n`,
  "express/auth.controller.ts": `
import { authService } from "./services";
const login = catchAsync(async (req, res) => {
  await authService.signIn(req.body);
});
`,
  "express/services/index.ts": `export { default as authService } from "./auth.service";\n`,
  "express/services/auth.service.ts": `
const signIn = async (body: unknown) => body;
export default { signIn };
`,
  "uow/uow.ts": `
export interface Repos { users: UserRepo }
export interface UserRepo { add(user: string): void }
export interface Uow { run<T>(work: (repos: Repos) => Promise<T>): Promise<T> }
export abstract class BaseRepo { add(user: string) { return user; } }
export class SqlUserRepo extends BaseRepo implements UserRepo {}
export class Service {
  constructor(private readonly uow: Uow) {}
  go() {
    return this.uow.run(async (repos) => repos.users.add("x"));
  }
}
`,
  "ambiguous/ports.ts": `
export interface Sender { send(message: string): void }
export class SmtpSender implements Sender { send(message: string) { return message; } }
export class SmsSender implements Sender { send(message: string) { return message; } }
export class Notifier {
  constructor(private readonly sender: Sender) {}
  notify() { return this.sender.send("hi"); }
}
export function dynamic(handlers: Record<string, () => void>, name: string) { return handlers[name](); }
`,
  "app/util.ts": `export function helper() { return 1; }\n`,
  "aliases/use.ts": `
import { helper } from "@app/util";
import { leak } from "@prisma/client";
export function useAliases() { helper(); return leak(); }
`,
  "overloads/server.ts": `
export class Router { attach(path: string) { return path; } }
export class Server {
  use(middleware: string): void;
  use(path: string, router: Router): void;
  use(arg1: string, arg2?: Router) {
    arg2?.attach(arg1);
  }
}
`,
  "ports/ports.ts": `
export abstract class CreatePort { abstract execute(input: string): string }
export class CreateInteractor implements CreatePort { execute(input: string) { return input; } }
export class ApiController {
  constructor(private readonly create: CreatePort) {}
  run() { return this.create.execute("x"); }
}
`,
  "container/index.ts": `export function build() { return 1; }\n`,
  "other/index.ts": `export function build() { return 2; }\n`,
  "aliases/container-use.ts": `
import { build } from "@container/index";
export function boot() { return build(); }
`,
  "client.ts": `export function leak() { return 2; }\n`,
  "deps/factory.ts": `
export interface Repository { save(entity: string): void }
const makeRepository = (): Repository => ({ save(entity: string) { return entity; } });
export function makeDependencies() {
  const repository = makeRepository();
  return { repository };
}
export type Dependencies = Awaited<ReturnType<typeof makeDependencies>>;
export function useCase({ repository }: Pick<Dependencies, "repository">) {
  return repository.save("x");
}
`,
};

const labelOf = (s: { container: string | null; symbol: string }): string => (s.container ? `${s.container}.${s.symbol}` : s.symbol);
const edgesOf = (graph: AstGraph, from: string): string[] => [...graph.edgesFrom.values()].flat().filter((e) => labelOf(e.from) === from).map((e) => `${e.kind}:${labelOf(e.to)}`);

let root = "";
let graph: AstGraph;
let inferred: AstGraph;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ast-spike-test-"));
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  graph = await buildAstGraph(root, FULL_AST);
  inferred = await buildAstGraph(root, INFERRED_AST);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("ast: optional chaining, chamada genérica e dependência injetada atrás de campo-com-chamada e decorator", () => {
  // Regex discovery loses this edge twice: the `new Logger(` before the constructor and `@Inject(TOKEN)` in the parameter list.
  expect(edgesOf(graph, "PaymentsController.create")).toEqual(["call:PaymentsService.create"]);
});

test("ast: `f<T>(…)`, `Classe.estático()` e `new X()` — a construção não é aresta", () => {
  expect(edgesOf(graph, "PaymentsService.create").sort()).toEqual(["call:Mapper.toDomain", "call:store"]);
});

test("ast: assinatura multilinha com tipo-objeto mantém o corpo; o handler é ponto de entrada por forma de requisição", () => {
  expect(edgesOf(graph, "registerHandler")).toEqual(["call:createUser"]);
  expect(graph.entries.map(labelOf)).toContain("registerHandler");
});

test("ast: const embrulhada em callback, barrel `export { default as x }` e objeto-módulo resolvem até a função", () => {
  expect(edgesOf(graph, "login")).toEqual(["call:signIn"]);
  expect(graph.entries.map(labelOf)).toContain("login");
});

test("ast: parâmetro de callback tipado pelo contrato do callee; herança + uma única implementação concreta", () => {
  expect(edgesOf(graph, "Service.go").sort()).toEqual(["call:Uow.run", "call:UserRepo.add"]);
  expect(edgesOf(graph, "UserRepo.add")).toEqual(["implements:BaseRepo.add"]);
});

test("ast: duas implementações e despacho dinâmico continuam sem prova", () => {
  expect(edgesOf(graph, "Notifier.notify")).toEqual(["call:Sender.send"]); // the call is proven, WHICH sender runs is not
  expect(edgesOf(graph, "Sender.send")).toEqual([]);
  expect(edgesOf(graph, "dynamic")).toEqual([]);
});

test("ast: alias de diretório do repositório resolve; escopo de pacote que só divide nome de arquivo não", () => {
  expect(edgesOf(graph, "useAliases")).toEqual(["call:helper"]);
  expect(graph.stats.aliasResolved.some((a) => a.includes("@app/util"))).toBe(true);
  expect(graph.stats.aliasResolved.some((a) => a.includes("@prisma/client"))).toBe(false);
});

test("ast: o corpo de um método sobrecarregado é lido (a assinatura sem corpo não consome a análise)", () => {
  expect(edgesOf(graph, "Server.use")).toEqual(["call:Router.attach"]);
});

test("ast: porta declarada como abstract class tem a mesma regra de implementação única que uma interface", () => {
  expect(edgesOf(graph, "ApiController.run")).toEqual(["call:CreatePort.execute"]);
  expect(edgesOf(graph, "CreatePort.execute")).toEqual(["implements:CreateInteractor.execute"]);
});

test("ast: `@dir/index` resolve pelo diretório do alias, não pelo sufixo `index` ambíguo", () => {
  expect(edgesOf(graph, "boot")).toEqual(["call:build"]);
  const edge = [...graph.edgesFrom.values()].flat().find((e) => e.from.symbol === "boot");
  expect(edge?.to.path).toBe("container/index.ts");
});

test("ast: ReturnType<typeof f> de função sem retorno anotado só é resolvido com a inferência opt-in", () => {
  expect(edgesOf(graph, "useCase")).toEqual([]);
  expect(edgesOf(inferred, "useCase")).toEqual(["call:Repository.save"]);
  expect(edgesOf(inferred, "Repository.save")).toEqual(["implements:makeRepository.save"]);
});

test("ast: discoverFlowAst segue a cadeia comprovada controller -> service para o objetivo", () => {
  const flow = discoverFlowAst("Quero entender como um pagamento é criado.", graph, "other");
  expect(flow.chain.map(labelOf)).toEqual(["PaymentsController.create", "PaymentsService.create"]);
});
