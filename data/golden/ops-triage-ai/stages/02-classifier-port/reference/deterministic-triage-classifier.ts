import { classify as classifyByKeywords, type Category, type TicketInput } from "./triage.ts";
import type { TriageClassifier } from "./triage-classifier.ts";

// A função da Stage 1 vira um detalhe de implementação atrás do contrato.
export class DeterministicTriageClassifier implements TriageClassifier {
  async classify(input: TicketInput): Promise<Category> {
    return classifyByKeywords(input);
  }
}
