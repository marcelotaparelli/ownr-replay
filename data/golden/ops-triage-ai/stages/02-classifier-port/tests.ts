import { test, expect } from "replay:test";
import { Category, type TicketInput } from "./triage.ts";
import type { TriageClassifier } from "./triage-classifier.ts";
import { DeterministicTriageClassifier } from "./deterministic-triage-classifier.ts";
import { TriageTicket } from "./triage-ticket.ts";

// Um classificador falso: responde sempre a mesma categoria e anota as chamadas.
class FakeClassifier implements TriageClassifier {
  readonly calls: TicketInput[] = [];
  constructor(private readonly answer: Category) {}
  async classify(input: TicketInput): Promise<Category> {
    this.calls.push(input);
    return this.answer;
  }
}

const ticket = { title: "Production is down", description: "Checkout returns 500 for everyone" };

test("DeterministicTriageClassifier cumpre o contrato (Promise<Category>)", async () => {
  const pending = new DeterministicTriageClassifier().classify(ticket);
  expect(pending).toBeInstanceOf(Promise);
  expect(await pending).toBe(Category.INCIDENT);
});

test("TriageTicket delega ao classificador recebido, uma vez, com o mesmo ticket", async () => {
  const fake = new FakeClassifier(Category.ACCESS);
  expect(await new TriageTicket(fake).execute(ticket)).toBe(Category.ACCESS);
  expect(fake.calls).toEqual([ticket]);
});

test("trocar a implementação não exige mudar TriageTicket", async () => {
  expect(await new TriageTicket(new FakeClassifier(Category.BUG)).execute(ticket)).toBe(Category.BUG);
  expect(await new TriageTicket(new DeterministicTriageClassifier()).execute(ticket)).toBe(Category.INCIDENT);
});

test("erros do classificador chegam a quem chamou", async () => {
  const failing: TriageClassifier = {
    classify: async () => {
      throw new Error("classificador fora do ar");
    },
  };
  await expect(() => new TriageTicket(failing).execute(ticket)).rejects.toBeInstanceOf(Error);
});
