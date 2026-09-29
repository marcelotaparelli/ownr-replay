import { join } from "node:path";
import { indexRepository, originalDir } from "./services/code-map.ts";
import { loadConfig } from "./config.ts";
import { Repository } from "./db/repository.ts";
import { createApi } from "./http/api.ts";
import { createApp } from "./http/app.ts";
import { logger } from "./obs/logger.ts";
import { Metrics } from "./obs/metrics.ts";
import { DockerSandboxRunner } from "./sandbox/docker-runner.ts";
import { TypeChecker, locateTsc } from "./sandbox/typecheck.ts";
import { loadAllJourneys } from "./services/curriculum.ts";
import { ModuleGenerationService, StageGenerator, StagePlanner, StageValidator } from "./services/stage-generation.ts";
import { TargetedJourneyStore } from "./services/targeted-journey.ts";
import { AnthropicTutorModel } from "./services/tutor-anthropic.ts";
import { TutorService } from "./services/tutor.ts";
import { buildWebAssets } from "./web-assets.ts";

const root = join(import.meta.dir, "..");
const config = loadConfig();
const metrics = new Metrics();
const repository = new Repository(config.DB_PATH);
const authored = loadAllJourneys(join(root, config.DATA_DIR));
const model = config.ANTHROPIC_API_KEY ? new AnthropicTutorModel(config.ANTHROPIC_API_KEY, config.TUTOR_MODEL) : null;
const tutor = new TutorService(repository, model, logger, metrics);
const sandbox = config.RUNNER === "docker" ? new DockerSandboxRunner() : null;
// Fail at boot, not on the learner's first run, if the checker a stage needs is missing.
const typeChecker = new TypeChecker(await locateTsc());
const generation = new ModuleGenerationService(join(root, "data/generated"), new StagePlanner(), new StageGenerator(), new StageValidator(typeChecker));
const targeted = new TargetedJourneyStore(join(root, "data/generated"));
const bases = authored.map((journey) => generation.restore(journey));
const journeys = [...bases, ...targeted.restore(bases)];
const codeIndexes = new Map(journeys.map((j) => [j.id, indexRepository(originalDir(join(root, config.DATA_DIR, j.repo.name)))]));
const api = createApi({ journeys, repository, tutor, sandbox, typeChecker, logger, metrics, codeIndexes, generation, targeted });
const assets = await buildWebAssets(join(root, "web"));

const server = Bun.serve({ hostname: "0.0.0.0", port: config.PORT, fetch: createApp(api, assets, logger, metrics) });
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
