import type { Category, TicketInput } from "./triage.ts";
import type { TriageClassifier } from "./triage-classifier.ts";

// Caso de uso: "triar um ticket". Conhece o contrato, nunca a implementação.
export class TriageTicket {
  constructor(private readonly classifier: TriageClassifier) {}

  async execute(input: TicketInput): Promise<Category> {
    return this.classifier.classify(input);
  }
}
