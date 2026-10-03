import { test, expect } from "bun:test";
import { declarationsOf, type RepositoryIndex } from "../src/services/code-map.ts";
import { discoverFlow } from "../src/services/flow-discovery.ts";

/**
 * Diagnostic reproductions of why flow discovery failed (or would mislead) on real public
 * repositories whose goal was "Quero entender como uma transação é persistida no banco de dados.":
 *   A  hesbonangwenyi606/wallet-payments-api @ 748643d   (NestJS + TypeORM)
 *   B  sultanfariz/bun-api-starter            @ 279b97a   (Express + Prisma)
 *   C  3loop/decoder-api                      @ 87bec4e   (Effect-TS)
 * Each test is the smallest source that isolates ONE structural limit, written as a pair: the shape
 * discovery follows today, and the near-identical shape it does not. They pin CURRENT behaviour, they
 * do not endorse it: when a limit is lifted, the matching "does not" assertion is expected to flip.
 */

const indexOf = (files: Record<string, string>): RepositoryIndex => ({
  files: new Map(Object.entries(files)),
  declarations: Object.entries(files).flatMap(([path, content]) => declarationsOf(path, content)),
});

const names = (chain: { symbol: string; container: string | null }[]): string[] => chain.map((node) => (node.container ? `${node.container}.${node.symbol}` : node.symbol));

const TRANSACTION_GOAL = "Quero entender como uma transação é persistida no banco de dados.";

// ---- Repo A: the start threshold is raised by a declaration that cannot start anything -------------

const transfersController = `
export class TransfersController {
  constructor(private readonly transfersService: TransfersService) {}

  transfer(dto: CreateTransferDto) {
    return this.transfersService.transfer(dto);
  }
}
`;
const transfersService = `
export class TransfersService {
  transfer(dto: CreateTransferDto) {
    return dto;
  }
}
`;
const createTransferDto = `
export class CreateTransferDto {
  amountMinorUnits!: number;
}
`;

test("A: a chamada controller -> service existe e é descoberta quando nada mais interfere", () => {
  const index = indexOf({ "controller.ts": transfersController, "service.ts": transfersService });
  expect(names(discoverFlow(TRANSACTION_GOAL, index, "other").chain)).toEqual(["TransfersController.transfer", "TransfersService.transfer"]);
});

test("A: um DTO sem corpo (CreateTransferDto) carrega 2 conceitos do objetivo e elimina todas as raízes", () => {
  const index = indexOf({ "controller.ts": transfersController, "service.ts": transfersService, "dto.ts": createTransferDto });
  // The same proven call is in the source, yet no flow: "create" (glossary of "persistida") plus
  // "transfer" (5-letter prefix of "transação") put the DTO at 2 concepts, no callable reaches 2,
  // so there is no start point. The message nevertheless claims no call is proven.
  expect(() => discoverFlow(TRANSACTION_GOAL, index, "other")).toThrow(/nenhuma chamada comprovada/);
});

// ---- Repo A (next wall): relevance is judged by names, so a read named after the goal beats the write -

test("A: leitura cujo nome contém o conceito vence a escrita cujo nome não o contém", () => {
  const index = indexOf({
    "ledger.ts": `
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  listTransactions(id: string) {
    return this.ledger.listTransactions(id);
  }

  transfer(amount: number) {
    return this.ledger.transfer(amount);
  }
}

export class LedgerService {
  listTransactions(id: string) {
    return this.toTransactionRow(id);
  }

  toTransactionRow(id: string) {
    return id;
  }

  transfer(amount: number) {
    return amount;
  }
}
`,
  });
  // `transfer` is the operation that writes (its body would call `save`), but names are all the
  // ranking sees: the read path wins by density, as it did in the real repository.
  expect(names(discoverFlow(TRANSACTION_GOAL, index, "other").chain)).toEqual(["LedgerController.listTransactions", "LedgerService.listTransactions", "LedgerService.toTransactionRow"]);
});

// ---- Repo B: the goal's word lives only in bodies, and a namespace import hides the call ----------

test("B: a palavra do objetivo que só aparece no corpo ($transaction) não é evidência: nenhum símbolo corresponde", () => {
  const index = indexOf({
    "auth.ts": `
export const register = async (req: Request) => {
  return await prisma.$transaction(async (tx) => tx.user.create({ data: req.body }));
};
`,
  });
  expect(() => discoverFlow(TRANSACTION_GOAL, index, "other")).toThrow(/Nenhum símbolo do repositório/);
});

const userSheet = `
export const insertUser = async (row: object) => {
  return row;
};
`;

test("B: import nomeado + chamada nua cria a aresta createUser -> insertUser", () => {
  const index = indexOf({
    "auth.ts": `
import { insertUser } from "./sheet";

export const createUser = async (req: Request) => {
  await insertUser({ id: 1 });
};
`,
    "sheet.ts": userSheet,
  });
  expect(names(discoverFlow("Quero entender como um usuário é criado.", index, "other").chain)).toEqual(["createUser", "insertUser"]);
});

test("B: import de namespace (import * as userSheet) + userSheet.insertUser() não cria a aresta", () => {
  const index = indexOf({
    "auth.ts": `
import * as userSheet from "./sheet";

export const createUser = async (req: Request) => {
  await userSheet.insertUser({ id: 1 });
};
`,
    "sheet.ts": userSheet,
  });
  expect(() => discoverFlow("Quero entender como um usuário é criado.", index, "other")).toThrow(/nenhuma chamada comprovada/);
});

// ---- Repo C: a handler bound to a call expression is not a callable start point ---------------------

test("C: handler escrito como função (const f = async () => ...) é raiz e a cadeia é descoberta", () => {
  const index = indexOf({
    "router.ts": `
const addMetadata = async () => {
  await saveMetadata();
};

const saveMetadata = async () => {
  return 1;
};
`,
  });
  expect(names(discoverFlow("Quero entender como o metadata é salvo.", index, "other").chain)).toEqual(["addMetadata", "saveMetadata"]);
});

test("C: o mesmo handler escrito como const X = Router.post(path, Effect.gen(...)) não é raiz: sem fluxo", () => {
  const index = indexOf({
    "router.ts": `
const addMetadata = HttpRouter.post("/add-metadata", Effect.gen(function* () {
  yield* saveMetadata();
}));

const saveMetadata = async () => {
  return 1;
};
`,
  });
  // addMetadata matches the goal and its body does call saveMetadata, but a value bound to a call
  // expression is "wiring", not behaviour (hasCallableBody), so it can neither start nor extend a chain.
  expect(() => discoverFlow("Quero entender como o metadata é salvo.", index, "other")).toThrow(/nenhuma chamada comprovada/);
});
