import type { TicketInput } from "./triage.ts";

export type RequestIssue = { field: string; code: string };
export type ParseResult = { success: true; data: TicketInput } | { success: false; issues: RequestIssue[] };

export function parseTicketInput(payload: unknown): ParseResult {
  // TODO: aceite apenas um objeto com exatamente title (≤ 200) e description (≤ 5000),
  // ambos strings não vazias após trim(). Devolva os valores já com trim().
  // Problemas viram issues: { field, code } com code "invalid_type" | "too_small" | "too_big" | "unrecognized_key".
  return { success: true, data: payload as TicketInput };
}
