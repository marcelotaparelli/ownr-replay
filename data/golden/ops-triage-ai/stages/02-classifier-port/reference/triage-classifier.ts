import type { Category, TicketInput } from "./triage.ts";

// O contrato: qualquer coisa capaz de classificar um ticket.
export interface TriageClassifier {
  classify(input: TicketInput): Promise<Category>;
}
