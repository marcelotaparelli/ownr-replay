import { ClassifierInvalidResponseError, ClassifierTimeoutError, ClassifierUnavailableError } from "./classifier-errors.ts";
import { parseTicketInput } from "./triage-request.ts";
import type { TriageDecision } from "./triage-decision.ts";
import type { TicketInput } from "./triage.ts";

export interface TriageService {
  execute(input: TicketInput): Promise<{ decisionId: string; decision: TriageDecision }>;
}

const BODY_LIMIT_BYTES = 32_768;

// POST /tickets/triage — só tradução: HTTP → caso de uso → HTTP.
export async function handleTriage(req: Request, service: TriageService): Promise<Response> {
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return json(415, { error: "unsupported_media_type" });
  }
  const text = await req.text();
  if (text.length > BODY_LIMIT_BYTES) return json(413, { error: "request_body_too_large" });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = parseTicketInput(payload);
  if (!parsed.success) return json(422, { error: "invalid_request", issues: parsed.issues });

  try {
    const { decisionId, decision } = await service.execute(parsed.data);
    return json(201, { id: decisionId, ...decision }, { location: `/triage/${decisionId}` });
  } catch (error) {
    const mapped = classifierResponse(error);
    return json(mapped.status, { error: mapped.code });
  }
}

export function classifierResponse(error: unknown): { status: number; code: string } {
  // TODO: timeout → 504 "classifier_timeout", indisponível → 503 "classifier_unavailable",
  // resposta inválida → 502 "classifier_invalid_response", qualquer outra coisa → 500 "internal_error".
  return { status: 500, code: "internal_error" };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
