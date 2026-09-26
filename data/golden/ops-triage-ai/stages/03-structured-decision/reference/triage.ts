export enum Category {
  INCIDENT = "INCIDENT",
  BUG = "BUG",
  ACCESS = "ACCESS",
  SUPPORT = "SUPPORT",
  OTHER = "OTHER",
}

export enum Priority {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export enum Risk {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
}

export enum SuggestedTeam {
  INFRASTRUCTURE = "INFRASTRUCTURE",
  DEVELOPMENT = "DEVELOPMENT",
  SUPPORT = "SUPPORT",
  HUMAN_REVIEW = "HUMAN_REVIEW",
}

export interface TicketInput {
  title: string;
  description: string;
}

// Três degraus, não um float: uma heurística não tem precisão de 0.83.
export type Confidence = 0.5 | 0.7 | 0.9;

// O que qualquer classificador devolve.
export interface ClassifierResult {
  category: Category;
  priority: Priority;
  risk: Risk;
  suggestedTeam: SuggestedTeam;
  confidence: Confidence;
  summary: string;
  rationale: string;
}
