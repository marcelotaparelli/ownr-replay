import type { ClassifierResult, TicketInput } from "./triage.ts";

export interface TriageClassifier {
  classify(input: TicketInput): Promise<ClassifierResult>;
}
