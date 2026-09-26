import { loadConfig } from "./config.ts";
import { DeterministicTriageClassifier } from "./application/classifiers/deterministic-triage-classifier.ts";
import { PersistedTriageService } from "./application/persisted-triage-service.ts";
import { TriageTicket } from "./application/triage-ticket.ts";
import type { TriageMode } from "./application/ports/triage-persistence.ts";
import { OllamaTriageClassifier } from "./infrastructure/ollama/ollama-triage-classifier.ts";
import {
  PrismaFeedbackRepository,
  PrismaTriageRunRepository,
} from "./infrastructure/persistence/prisma-triage-repositories.ts";
import { getPrisma } from "./db.ts";
import { startServer, stopServer } from "./server.ts";
import { Metrics, stdoutLogger } from "./observability.ts";

const config = loadConfig();
const deterministicClassifier = new DeterministicTriageClassifier();
const triageTicket =
  config.TRIAGE_CLASSIFIER === "deterministic"
    ? new TriageTicket({ mode: "deterministic", classifier: deterministicClassifier })
    : new TriageTicket(
        config.TRIAGE_CLASSIFIER === "ollama"
          ? { mode: "ollama", classifier: createOllamaClassifier() }
          : {
              mode: "hybrid",
              deterministicClassifier,
              llmClassifier: createOllamaClassifier(),
            },
      );
const prisma = getPrisma(config.DATABASE_URL);
const triageRunRepository = new PrismaTriageRunRepository(prisma);
const metrics = new Metrics();
const triageService = new PersistedTriageService(
  triageTicket,
  toTriageMode(config.TRIAGE_CLASSIFIER),
  triageRunRepository,
  new PrismaFeedbackRepository(prisma),
);
const cutoff = new Date(Date.now() - config.STALE_RUN_THRESHOLD_MS);
const reconciled = await triageRunRepository.reconcileStaleRuns(cutoff);
metrics.set("stale_runs_reconciled_total", reconciled);
const statusCounts = await triageRunRepository.getStatusCounts();
for (const [status, count] of Object.entries(statusCounts)) metrics.set("triage_runs", count, { status });
stdoutLogger.log("info", "stale_runs_reconciled", { count: reconciled });
const server = startServer(config.PORT, config.DATABASE_URL, triageService, {
  ...(config.TRIAGE_API_KEY === undefined ? {} : { apiKey: config.TRIAGE_API_KEY }),
  bodyLimitBytes: config.HTTP_BODY_LIMIT_BYTES,
  maxConcurrentTriages: config.TRIAGE_MAX_CONCURRENCY,
  requestTimeoutMs: config.REQUEST_TIMEOUT_MS,
  metrics,
  logger: stdoutLogger,
});
stdoutLogger.log("info", "server_started", { status: config.PORT });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  stdoutLogger.log("info", "shutdown_started", { code: signal });
  await stopServer(server);
  stdoutLogger.log("info", "shutdown_completed", { code: signal });
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", () => {
  stdoutLogger.log("error", "unexpected_error", { code: "UNCAUGHT_EXCEPTION" });
  void shutdown("uncaughtException").finally(() => process.exit(1));
});
process.on("unhandledRejection", () => {
  stdoutLogger.log("error", "unexpected_error", { code: "UNHANDLED_REJECTION" });
  void shutdown("unhandledRejection").finally(() => process.exit(1));
});

function createOllamaClassifier(): OllamaTriageClassifier {
  if (config.TRIAGE_CLASSIFIER === "deterministic") {
    throw new Error("Ollama classifier is not configured");
  }
  return new OllamaTriageClassifier({
    baseUrl: config.OLLAMA_BASE_URL,
    model: config.OLLAMA_MODEL,
    timeoutMs: config.OLLAMA_TIMEOUT_MS,
  });
}

function toTriageMode(value: "deterministic" | "ollama" | "hybrid"): TriageMode {
  return value.toUpperCase() as TriageMode;
}
