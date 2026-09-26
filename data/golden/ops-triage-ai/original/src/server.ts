import { checkDatabase, closePrisma, getPrisma } from "./db.ts";
import { ClassifierInvalidResponseError, ClassifierTimeoutError, ClassifierUnavailableError } from "./application/errors/classifier-errors.ts";
import type { TriageService } from "./application/ports/triage-service.ts";
import { parseFeedbackInput } from "./http/feedback-request.ts";
import { parseTicketInput } from "./http/triage-request.ts";
import { Metrics, safeRequestId, stdoutLogger, type AppLogger } from "./observability.ts";

export type DbChecker = () => Promise<boolean>;
export interface ServerDependencies {
  checkDb: DbChecker;
  triageService: TriageService;
  apiKey?: string;
  bodyLimitBytes?: number;
  maxConcurrentTriages?: number;
  requestTimeoutMs?: number;
  metrics?: Metrics;
  logger?: AppLogger;
}

const DEFAULT_BODY_LIMIT = 32_768;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_REQUEST_TIMEOUT = 310_000;
const defaultMetrics = new WeakMap<object, Metrics>();

function json(status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": requestId, ...headers } });
}

export async function handleRequest(req: Request, dependencies: ServerDependencies): Promise<Response> {
  const requestId = safeRequestId(req.headers.get("x-request-id"));
  const startedAt = performance.now();
  const metrics = dependencies.metrics ?? metricsFor(dependencies);
  const logger = dependencies.logger ?? stdoutLogger;
  const route = routeName(req);
  let response: Response;
  try {
    response = await routeRequest(req, requestId, dependencies, metrics, logger);
  } catch {
    metrics.increment("unexpected_errors_total", { route });
    logger.log("error", "unexpected_error", { requestId, route, code: "INTERNAL_ERROR" });
    response = json(500, { error: "internal_error" }, requestId);
  }
  metrics.increment("requests_total", { route, status: String(response.status) });
  metrics.observe("request_duration_ms", performance.now() - startedAt, { route });
  logger.log("info", "request_completed", { requestId, route, status: response.status, durationMs: Math.round(performance.now() - startedAt) });
  return response;
}

async function routeRequest(req: Request, requestId: string, dependencies: ServerDependencies, metrics: Metrics, logger: AppLogger): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/ready")) {
    try {
      await dependencies.checkDb();
      return json(200, url.pathname === "/health" ? { status: "healthy", db: "up" } : { status: "ready" }, requestId);
    } catch {
      metrics.increment(url.pathname === "/health" ? "health_failures_total" : "readiness_failures_total");
      return json(503, url.pathname === "/health" ? { status: "unhealthy", db: "down" } : { status: "not_ready" }, requestId);
    }
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    if (!authorized(req, dependencies.apiKey)) return json(401, { error: "unauthorized" }, requestId);
    return json(200, metrics.snapshot(), requestId);
  }
  const triagePath = /^\/triage\/([^/]+)$/.exec(url.pathname);
  const feedbackPath = /^\/triage\/([^/]+)\/feedback$/.exec(url.pathname);
  if ((url.pathname === "/tickets/triage" || triagePath || feedbackPath) && !authorized(req, dependencies.apiKey)) {
    return json(401, { error: "unauthorized" }, requestId);
  }
  if (req.method === "POST" && url.pathname === "/tickets/triage") {
    if (!isJson(req)) return json(415, { error: "unsupported_media_type" }, requestId);
    const payload = await readJson(req, dependencies.bodyLimitBytes ?? DEFAULT_BODY_LIMIT);
    if (!payload.success) return json(payload.status, { error: payload.error }, requestId);
    const parsed = parseTicketInput(payload.value);
    if (!parsed.success) return json(422, { error: "invalid_request", issues: parsed.issues }, requestId);
    const limiter = getLimiter(dependencies);
    if (!limiter.tryAcquire()) return json(429, { error: "too_many_requests" }, requestId, { "retry-after": "1" });
    logger.log("info", "triage_started", { requestId });
    const triageStarted = performance.now();
    try {
      const execution = await withTimeout(dependencies.triageService.execute(parsed.data), dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT);
      metrics.increment("triage_total", { decisionSource: execution.decision.decisionSource });
      if (execution.decision.requiresHumanReview) metrics.increment("triage_human_review_total");
      for (const reason of execution.decision.reviewReasons) metrics.increment("triage_review_reasons_total", { reason });
      metrics.observe("triage_duration_ms", performance.now() - triageStarted);
      logger.log("info", "triage_completed", { requestId, decisionId: execution.decisionId, status: 201, durationMs: Math.round(performance.now() - triageStarted), decisionSource: execution.decision.decisionSource, requiresHumanReview: execution.decision.requiresHumanReview });
      return json(201, { id: execution.decisionId, ...execution.decision }, requestId, { location: `/triage/${execution.decisionId}` });
    } catch (error) {
      const mapped = classifierResponse(error);
      metrics.increment(mapped.metric);
      logger.log(mapped.status >= 500 ? "warn" : "error", mapped.event, { requestId, code: mapped.code });
      return json(mapped.status, { error: mapped.code }, requestId);
    } finally { limiter.release(); }
  }
  if (triagePath || feedbackPath) {
    const decisionId = (triagePath ?? feedbackPath)?.[1] ?? "";
    if (!isUuid(decisionId)) return json(400, { error: "invalid_triage_id" }, requestId);
    if (req.method === "GET" && triagePath) {
      try {
        const audit = await dependencies.triageService.getDecisionAudit(decisionId);
        return audit ? json(200, audit, requestId) : json(404, { error: "triage_not_found" }, requestId);
      } catch {
        metrics.increment("persistence_errors_total");
        logger.log("error", "persistence_error", { requestId, decisionId, code: "AUDIT_READ_FAILED" });
        return json(500, { error: "internal_error" }, requestId);
      }
    }
    if (req.method === "POST" && feedbackPath) {
      if (!isJson(req)) return json(415, { error: "unsupported_media_type" }, requestId);
      const payload = await readJson(req, dependencies.bodyLimitBytes ?? DEFAULT_BODY_LIMIT);
      if (!payload.success) return json(payload.status, { error: payload.error }, requestId);
      const parsed = parseFeedbackInput(payload.value);
      if (!parsed.success) return json(422, { error: "invalid_feedback", issues: parsed.issues }, requestId);
      try {
        const audit = await dependencies.triageService.getDecisionAudit(decisionId);
        if (!audit) return json(404, { error: "triage_not_found" }, requestId);
        const feedback = await dependencies.triageService.addFeedback(decisionId, parsed.data);
        metrics.increment("feedback_created_total");
        logger.log("info", "feedback_created", { requestId, decisionId });
        return json(201, feedback, requestId);
      } catch {
        metrics.increment("persistence_errors_total");
        logger.log("error", "persistence_error", { requestId, decisionId, code: "FEEDBACK_CREATE_FAILED" });
        return json(500, { error: "internal_error" }, requestId);
      }
    }
  }
  return json(404, { status: "not_found" }, requestId);
}

function isJson(req: Request): boolean { return req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json"; }
async function readJson(req: Request, limit: number): Promise<{ success: true; value: unknown } | { success: false; status: 400 | 413; error: "invalid_json" | "request_body_too_large" }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { success: false, status: 413, error: "request_body_too_large" };
  try {
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > limit) return { success: false, status: 413, error: "request_body_too_large" };
    return { success: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch { return { success: false, status: 400, error: "invalid_json" }; }
}
function authorized(req: Request, expected: string | undefined): boolean {
  if (!expected) return true;
  const provided = req.headers.get("x-api-key");
  if (!provided || provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}
function routeName(req: Request): string {
  const path = new URL(req.url).pathname;
  if (path === "/tickets/triage") return "POST /tickets/triage";
  if (path === "/metrics") return "GET /metrics";
  if (path === "/health") return "GET /health";
  if (path === "/ready") return "GET /ready";
  if (/^\/triage\/[^/]+\/feedback$/.test(path)) return "POST /triage/:id/feedback";
  if (/^\/triage\/[^/]+$/.test(path)) return "GET /triage/:id";
  return "unknown";
}
function classifierResponse(error: unknown): { status: number; code: string; metric: string; event: string } {
  if (error instanceof ClassifierTimeoutError) return { status: 504, code: "classifier_timeout", metric: "classifier_timeouts_total", event: "classifier_timeout" };
  if (error instanceof ClassifierUnavailableError) return { status: 503, code: "classifier_unavailable", metric: "classifier_unavailable_total", event: "classifier_unavailable" };
  if (error instanceof ClassifierInvalidResponseError) return { status: 502, code: "classifier_invalid_response", metric: "classifier_invalid_response_total", event: "classifier_invalid_response" };
  if (error instanceof Error && error.message === "request_timeout") return { status: 504, code: "request_timeout", metric: "request_timeouts_total", event: "request_timeout" };
  return { status: 500, code: "internal_error", metric: "unexpected_errors_total", event: "unexpected_error" };
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("request_timeout")), timeoutMs); });
  try { return await Promise.race([promise, timeout]); } finally { if (timer) clearTimeout(timer); }
}
class ConcurrencyLimiter {
  private active = 0;
  constructor(private readonly limit: number) {}
  tryAcquire(): boolean { if (this.active >= this.limit) return false; this.active += 1; return true; }
  release(): void { this.active = Math.max(0, this.active - 1); }
}
const limiters = new WeakMap<object, ConcurrencyLimiter>();
function getLimiter(dependencies: ServerDependencies): ConcurrencyLimiter {
  const key = dependencies as object;
  let limiter = limiters.get(key);
  if (!limiter) { limiter = new ConcurrencyLimiter(dependencies.maxConcurrentTriages ?? DEFAULT_CONCURRENCY); limiters.set(key, limiter); }
  return limiter;
}
function metricsFor(dependencies: ServerDependencies): Metrics {
  const key = dependencies as object;
  let metrics = defaultMetrics.get(key);
  if (!metrics) { metrics = new Metrics(); defaultMetrics.set(key, metrics); }
  return metrics;
}
export function createRealDbChecker(databaseUrl: string): DbChecker { return async () => checkDatabase(getPrisma(databaseUrl)); }
export function startServer(port: number, databaseUrl: string, triageService: TriageService, options: Omit<ServerDependencies, "checkDb" | "triageService"> = {}) {
  const dependencies: ServerDependencies = { ...options, checkDb: createRealDbChecker(databaseUrl), triageService };
  let draining = false;
  let active = 0;
  let idleResolver: (() => void) | undefined;
  const server = Bun.serve({
    port,
    fetch: async (req) => {
      if (draining) return json(503, { error: "server_shutting_down" }, safeRequestId(req.headers.get("x-request-id")), { "retry-after": "1" });
      active += 1;
      try { return await handleRequest(req, dependencies); }
      finally { active -= 1; if (active === 0) idleResolver?.(); }
    },
  });
  return Object.assign(server, { beginShutdown: () => { draining = true; }, waitForIdle: async (timeoutMs = 5_000) => {
    if (active === 0) return;
    await Promise.race([new Promise<void>((resolve) => { idleResolver = resolve; }), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  } });
}
export async function stopServer(server: { stop: () => void; beginShutdown?: () => void; waitForIdle?: () => Promise<void> }): Promise<void> {
  server.beginShutdown?.();
  server.stop();
  await server.waitForIdle?.();
  await closePrisma();
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
