export enum Category {
  INCIDENT = "INCIDENT",
  BUG = "BUG",
  FEATURE_REQUEST = "FEATURE_REQUEST",
  CONTENT_CHANGE = "CONTENT_CHANGE",
  SUPPORT = "SUPPORT",
  ACCESS = "ACCESS",
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
  DEVELOPMENT = "DEVELOPMENT",
  INFRASTRUCTURE = "INFRASTRUCTURE",
  CONTENT = "CONTENT",
  SUPPORT = "SUPPORT",
  PRODUCT = "PRODUCT",
  HUMAN_REVIEW = "HUMAN_REVIEW",
}

export interface TicketInput {
  title: string;
  description: string;
}

export type HeuristicConfidence = 0.5 | 0.7 | 0.9;

export interface ClassifierResult {
  category: Category;
  priority: Priority;
  risk: Risk;
  suggestedTeam: SuggestedTeam;
  confidence: HeuristicConfidence;
  summary: string;
  rationale: string;
}
