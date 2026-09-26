import { classify as classifyByKeywords, Category, type TicketInput } from "./triage.ts";
import type { TriageClassifier } from "./triage-classifier.ts";

export class DeterministicTriageClassifier implements TriageClassifier {
  async classify(input: TicketInput): Promise<Category> {
    // TODO: reutilize a classificação por palavras-chave da Stage 1.
    return Category.OTHER;
  }
}
