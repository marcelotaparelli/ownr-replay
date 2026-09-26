import type { Category, TicketInput } from "./triage.ts";
import type { TriageClassifier } from "./triage-classifier.ts";

export class TriageTicket {
  // TODO: receba o TriageClassifier pelo construtor — não crie um aqui dentro.

  async execute(input: TicketInput): Promise<Category> {
    // TODO: delegue ao classificador recebido.
    throw new Error("não implementado");
  }
}
