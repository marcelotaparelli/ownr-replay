import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { golden, resilientSource } from "./helpers.ts";
import { declarationsOf, indexRepository, originalDir, type RepositoryIndex } from "../src/services/code-map.ts";
import type { Journey } from "../src/domain/journey.ts";
import type { Stage } from "../src/domain/stage.ts";
import { discoverFlow, isInterfaceDeclaration } from "../src/services/flow-discovery.ts";
import { noveltyReport } from "../src/services/curriculum-check.ts";
import { locateTsc, TypeChecker } from "../src/sandbox/typecheck.ts";
import { ModuleGenerationService, StageGenerator, StagePlanner, StageValidator } from "../src/services/stage-generation.ts";

/**
 * Where the provable chain leaves the repository. The structural pattern, found in real NestJS-style services: a local
 * class EXTENDS a type imported from a package, is INJECTED into a service, and the service calls a member the package
 * provides (`this.db.payments.create(...)`). The chain used to stop at the service because that only call goes through
 * a type the repository does not declare. The repository below is synthetic, with an invented package: the capability
 * is generic and nothing here is a recipe or a copy of any real project.
 */
const checker = new TypeChecker(await locateTsc());
const GOAL = "Quero entender como um payment é criado.";
const label = (s: { container: string | null; symbol: string }): string => (s.container ? `${s.container}.${s.symbol}` : s.symbol);
const service = () => new ModuleGenerationService(mkdtempSync(join(tmpdir(), "replay-external-")), new StagePlanner(), new StageGenerator(), new StageValidator(checker));
const generate = (base: Journey, index: RepositoryIndex, goal: string) => service().generateRequestJourney(base, goal, index, "other");
const codeOf = (stage: Stage): string => stage.exercise?.solutionFiles[0]?.content ?? "";
const mini = (files: Record<string, string>): RepositoryIndex => ({ files: new Map(Object.entries(files)), declarations: Object.entries(files).flatMap(([path, content]) => declarationsOf(path, content)) });
// Only the pinned repository identity is borrowed; every file below lives in memory.
const MINI_BASE: Journey = { ...resilientSource().base, id: "mini-repo", title: "mini-repo" };

const PAYMENTS: Record<string, string> = {
  "src/payments/payments.controller.ts": [
    'import { PaymentsService } from "./payments.service";',
    "export class PaymentsController {",
    "  constructor(private readonly payments: PaymentsService) {}",
    "  create(user: { id: string }, dto: { payee: string; amount: number; currency: string; fee: number }) {",
    "    return this.payments.create(user.id, dto.payee, dto.amount, dto.currency, dto.fee);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/payments/payments.service.ts": [
    'import { DataService } from "../data/data.service";',
    "export class PaymentsService {",
    "  constructor(private readonly db: DataService) {}",
    "  create(senderId: string, payee: string, amount: number, currency = 'USD', fee = 0) {",
    "    return this.db.payments.create({ data: { senderId, payee, amount, currency, fee, status: 'pending' } });",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/data/data.service.ts": ['import { OrmClient } from "some-orm";', "export class DataService extends OrmClient {", "  connect() {}", "}", ""].join("\n"),
};
const payments = mini(PAYMENTS);

test("fronteira externa: controller → service continua correto e a fronteira é a chamada real do service", () => {
  const flow = discoverFlow(GOAL, payments, "other");
  expect(flow.chain.map(label)).toEqual(["PaymentsController.create", "PaymentsService.create"]);
  expect(flow.edges).toHaveLength(1);
  expect(flow.edges[0]).toMatchObject({ kind: "call", snippet: "return this.payments.create(user.id, dto.payee, dto.amount, dto.currency, dto.fee);" });

  const external = flow.external!;
  expect(external).toMatchObject({ dependency: "DataService", base: "OrmClient", module: "some-orm", members: ["payments", "create"], receiver: ["this", "db", "payments"] });
  expect(external.from).toEqual(flow.target);
  // The call site is a literal line of the source, and its arguments are the real ones.
  expect(payments.files.get(external.from.path)?.split("\n")[external.line - 1]?.trim()).toBe(external.snippet);
  expect(external.argsText).toContain("status: 'pending'");
  expect(external.signature).toBe("create(senderId: string, payee: string, amount: number, currency = 'USD', fee = 0)");
});

test("fronteira externa: o Replay segue o service até a fronteira e preserva a estrutura real", async () => {
  const route = await generate(MINI_BASE, payments, GOAL);
  const stages = route.stages;
  expect(route.goal).toEqual({ kind: "other", note: GOAL });
  expect(route.description).toContain("até OrmClient.payments.create, do pacote some-orm");
  expect(stages.map((s) => s.kind)).toEqual(["micro", "micro", "checkpoint"]);
  expect(stages.map((s) => s.title)).toEqual(["Encaminhar para PaymentsService.create", "Chamar payments.create de OrmClient", "Checkpoint: reconstrua a cadeia descoberta"]);

  // Stage 1: the service is still a body-less leaf.
  expect(codeOf(stages[0]!)).toContain("constructor(private readonly payments: PaymentsService) {}");
  expect(codeOf(stages[0]!)).toContain("return this.payments.create();");
  expect(codeOf(stages[0]!)).toContain('return "corpo omitido: PaymentsService.create";');

  const code = codeOf(stages[1]!);
  for (const line of [
    'import { OrmClient } from "./external.ts";',
    "constructor(private readonly db: DataService) {}",
    "return this.db.payments.create();",
    "export class DataService extends OrmClient {}",
  ]) expect(code).toContain(line);
  // Received, not constructed; the package's class is given, not redeclared, and nothing is a placeholder relation.
  expect(code).not.toMatch(/\bnew\s/);
  expect(code).not.toContain("reached:");
  expect(code).not.toContain("class OrmClient");
  expect(isInterfaceDeclaration(payments, "src/data/data.service.ts", "DataService")).toBe(false);
  expect(stages[1]!.exercise?.supportFiles.map((f) => f.path)).toEqual(["external.ts"]);
  expect(stages[0]!.exercise?.supportFiles).toEqual([]);

  // The narrative says what is proven and where it stops.
  expect(stages[1]!.context).toContain('importado do pacote "some-orm"');
  expect(stages[1]!.explanation[0]!.normal).toContain("a análise estática não vê o que ele faz");
  expect(stages[1]!.explanation[0]!.normal).toContain("status: 'pending'");
  const checkpoint = stages.at(-1)!;
  expect(checkpoint.checkpoint?.answer).toContain("this.db.payments.create");
  expect(checkpoint.checkpoint?.answer).toContain("status: 'pending'");
  expect(checkpoint.checkpoint?.answer).toContain("currency = 'USD'");
  expect(checkpoint.exercise?.starterFiles.every((f) => f.content === "")).toBe(true);

  // References are exact slices of the pinned source: the real call site and the real class.
  const refs = stages[1]!.originalCodeRefs;
  expect(refs.map((r) => `${r.path}#${r.symbol}`)).toEqual(["src/payments/payments.service.ts#create", "src/data/data.service.ts#DataService"]);
  for (const ref of refs) {
    expect(payments.files.get(ref.path)?.includes(ref.snippet)).toBe(true);
    expect(ref.url).toContain(MINI_BASE.repo.sha);
  }
  expect(noveltyReport(stages).every((row) => row.newLines <= 5 || row.exception !== undefined)).toBe(true);
});

test("objetivos anteriores não ganham fronteira: nenhuma cadeia dos outros repositórios sai do código", () => {
  const rta = resilientSource();
  const ops = indexRepository(originalDir(join(import.meta.dir, "../data/golden/ops-triage-ai")));
  expect(discoverFlow("Quero entender como uma transação é persistida no banco de dados.", rta.index, "trace_request").external).toBeNull();
  expect(discoverFlow("Quero entender como funciona a autenticação das requisições", rta.index, "trace_request").external).toBeNull();
  expect(discoverFlow("Quero entender como uma decisão de triagem é persistida no banco de dados.", ops, "trace_request").external).toBeNull();
  expect(golden().id).toBe("ops-triage-ai");
});

const ORDERS = (extra: string, service: string): Record<string, string> => ({
  "src/orders.controller.ts": ['import { OrderService } from "./orders.service";', "export class OrderController {", "  constructor(private svc: OrderService) {}", "  place(order: string) {", "    return this.svc.place(order);", "  }", "}", ""].join("\n"),
  "src/orders.service.ts": service,
  "src/db.ts": extra,
});

test("o mesmo padrão sem receita: tipo importado de um pacote, chamado direto (sem classe do repositório no meio)", async () => {
  const index = mini(
    ORDERS("", [
      'import { Queue } from "some-queue";',
      "export class OrderService {",
      "  constructor(private queue: Queue) {}",
      "  place(order: string) {",
      "    return this.queue.add(order);",
      "  }",
      "}",
      "",
    ].join("\n")),
  );
  const flow = discoverFlow("Quero entender order", index, "other");
  expect(flow.chain.map(label)).toEqual(["OrderController.place", "OrderService.place"]);
  expect(flow.external).toMatchObject({ dependency: "Queue", base: "Queue", module: "some-queue", members: ["add"] });

  const route = await generate(MINI_BASE, index, "Quero entender order");
  const code = codeOf(route.stages.at(-1)!);
  expect(code).toContain("constructor(private readonly queue: Queue) {}");
  expect(code).toContain("return this.queue.add();");
  expect(code).not.toContain("class Queue");
  expect(route.stages.at(-1)?.exercise?.supportFiles[0]?.content).toContain('Stand-in de "some-queue"');
});

test("o mesmo padrão sem receita: classe do repositório que estende a do pacote, membro com vários níveis", () => {
  const index = mini(
    ORDERS(
      ['import { OrmClient } from "some-orm";', "export class Database extends OrmClient {", "  connect() {}", "}", ""].join("\n"),
      ['import { Database } from "./db";', "export class OrderService {", "  constructor(private db: Database) {}", "  place(order: string) {", "    return this.db.orders.insert({ order });", "  }", "}", ""].join("\n"),
    ),
  );
  expect(discoverFlow("Quero entender order", index, "other").external).toMatchObject({ dependency: "Database", base: "OrmClient", module: "some-orm", members: ["orders", "insert"] });
});

test("sem prova, sem fronteira: membro declarado pelo repositório, chamada irrelevante, empate ou receptor não injetado", () => {
  const withService = (body: string, db = ['import { OrmClient } from "some-orm";', "export class Database extends OrmClient {", "  orders = { insert: (order: string) => order };", "}", ""].join("\n")) =>
    mini(ORDERS(db, ['import { Database } from "./db";', "export class OrderService {", "  constructor(private db: Database) {}", "  place(order: string) {", ...body.split("\n"), "  }", "}", ""].join("\n")));
  const external = (index: RepositoryIndex) => discoverFlow("Quero entender order", index, "other").external;
  // The class declares the member itself: it is the repository's own code, not the package's.
  expect(external(withService("    return this.db.orders.insert(order);"))).toBeNull();
  // Not about the goal: nothing says this call is part of the story.
  const unrelated = ['import { OrmClient } from "some-orm";', "export class Database extends OrmClient {}", ""].join("\n");
  expect(external(withService("    return this.db.audit.flush();", unrelated))).toBeNull();
  // Two equally relevant calls out of the repository: no way to prove which one is "the" step.
  expect(external(withService("    this.db.orders.insert(order);\n    return this.db.orders.update(order);", unrelated))).toBeNull();
  // A receiver that is not a declared dependency (a global) is not a boundary either.
  expect(external(withService("    return Math.max(order.length, 1);", unrelated))).toBeNull();
  // A class that extends something NOT imported from a package (declared nowhere) proves nothing.
  expect(external(withService("    return this.db.orders.insert(order);", ["export class Database extends Mystery {}", ""].join("\n")))).toBeNull();
});
