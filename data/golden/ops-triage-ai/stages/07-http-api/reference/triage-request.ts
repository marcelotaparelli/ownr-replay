import type { TicketInput } from "./triage.ts";

export type RequestIssue = { field: string; code: string };
export type ParseResult = { success: true; data: TicketInput } | { success: false; issues: RequestIssue[] };

const LIMITS = { title: 200, description: 5_000 } as const;

// O que o z.object({...}).strict() do projeto real faz, explícito:
// só title e description, strings, sem espaços nas pontas, não vazias, com limite.
export function parseTicketInput(payload: unknown): ParseResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { success: false, issues: [{ field: "body", code: "invalid_type" }] };
  }
  const body = payload as Record<string, unknown>;
  const issues: RequestIssue[] = Object.keys(body)
    .filter((key) => !(key in LIMITS))
    .map((key) => ({ field: key, code: "unrecognized_key" }));
  const data: Record<string, string> = {};
  for (const [field, max] of Object.entries(LIMITS)) {
    const value = body[field];
    if (typeof value !== "string") issues.push({ field, code: "invalid_type" });
    else if (value.trim().length === 0) issues.push({ field, code: "too_small" });
    else if (value.trim().length > max) issues.push({ field, code: "too_big" });
    else data[field] = value.trim();
  }
  if (issues.length > 0) return { success: false, issues };
  return { success: true, data: { title: data.title ?? "", description: data.description ?? "" } };
}
