import { Category, Priority, Risk, type ClassifierResult } from "./triage.ts";

export type LlmResult = Omit<ClassifierResult, "suggestedTeam">;

const FIELDS = ["category", "priority", "risk", "confidence", "summary", "rationale"];

// O que o schema Zod do projeto real verifica, escrito à mão:
// objeto estrito, enums válidos, confiança discreta, textos não vazios e curtos.
export function parseLlmResult(value: unknown): LlmResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !FIELDS.includes(key))) return undefined;
  if (!isOneOf(v.category, Object.values(Category))) return undefined;
  if (!isOneOf(v.priority, Object.values(Priority))) return undefined;
  if (!isOneOf(v.risk, Object.values(Risk))) return undefined;
  if (v.confidence !== 0.5 && v.confidence !== 0.7 && v.confidence !== 0.9) return undefined;
  if (!isText(v.summary, 160) || !isText(v.rationale, 240)) return undefined;
  return {
    category: v.category,
    priority: v.priority,
    risk: v.risk,
    confidence: v.confidence,
    summary: v.summary,
    rationale: v.rationale,
  };
}

function isOneOf<T extends string>(value: unknown, options: T[]): value is T {
  return typeof value === "string" && (options as string[]).includes(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
