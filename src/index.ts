import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Repository } from "./db/repository.ts";
import { createApi } from "./http/api.ts";
import { createApp } from "./http/app.ts";
import { logger } from "./obs/logger.ts";
import { Metrics } from "./obs/metrics.ts";
import { DockerSandboxRunner } from "./sandbox/docker-runner.ts";
import { loadAllJourneys } from "./services/curriculum.ts";
import { AnthropicTutorModel } from "./services/tutor-anthropic.ts";
import { TutorService } from "./services/tutor.ts";
import { buildWebAssets } from "./web-assets.ts";

const root = join(import.meta.dir, "..");
const config = loadConfig();
const metrics = new Metrics();
const repository = new Repository(config.DB_PATH);
const journeys = loadAllJourneys(join(root, config.DATA_DIR));
const model = config.ANTHROPIC_API_KEY ? new AnthropicTutorModel(config.ANTHROPIC_API_KEY, config.TUTOR_MODEL) : null;
const tutor = new TutorService(repository, model, logger, metrics);
const sandbox = config.RUNNER === "docker" ? new DockerSandboxRunner() : null;
const api = createApi({ journeys, repository, tutor, sandbox, logger, metrics });
const assets = await buildWebAssets(join(root, "web"));

const server = Bun.serve({ port: config.PORT, fetch: createApp(api, assets, logger, metrics) });
logger.info("server_started", {
  url: server.url.toString(),
  journeys: journeys.length,
  tutor: model ? `llm:${config.TUTOR_MODEL}` : "offline",
  runner: config.RUNNER,
});

const shutdown = (): void => {
  server.stop();
  repository.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
