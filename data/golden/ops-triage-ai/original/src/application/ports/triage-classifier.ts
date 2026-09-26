import type { ClassifierResult, TicketInput } from "../../domain/triage.ts";

export interface TriageClassifier {
  classify(input: TicketInput): Promise<ClassifierResult>;
}
