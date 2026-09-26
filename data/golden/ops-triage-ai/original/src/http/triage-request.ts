import { z } from "zod";
import type { TicketInput } from "../domain/triage.ts";

const TicketInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5_000),
  })
  .strict();

export interface RequestIssue {
  field: string;
  code: string;
}

export type TicketInputParseResult =
  | { success: true; data: TicketInput }
  | { success: false; issues: RequestIssue[] };

export function parseTicketInput(payload: unknown): TicketInputParseResult {
  const parsed = TicketInputSchema.safeParse(payload);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      code: issue.code,
    })),
  };
}
