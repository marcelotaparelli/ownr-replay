import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { indexRepository, originalDir } from "../src/services/code-map.ts";
import { Repository } from "../src/db/repository.ts";
import type { Journey } from "../src/domain/journey.ts";
import { createApi } from "../src/http/api.ts";
import { createApp } from "../src/http/app.ts";
import { silentLogger } from "../src/obs/logger.ts";
import { Metrics } from "../src/obs/metrics.ts";
import { loadAllJourneys } from "../src/services/curriculum.ts";
import { TutorService, type TutorModel } from "../src/services/tutor.ts";
import type { TypeChecker } from "../src/sandbox/typecheck.ts";
import type { ModuleGenerationService } from "../src/services/stage-generation.ts";
import { TargetedJourneyStore } from "../src/services/targeted-journey.ts";

export const goldenJourneys = (): Journey[] => loadAllJourneys(join(import.meta.dir, "../data/golden"));

export function golden(): Journey {
  const journey = goldenJourneys().find((j) => j.id === "ops-triage-ai");
  if (!journey) throw new Error("golden journey missing");
  return journey;
}

export function testApp(options: { model?: TutorModel; typeChecker?: TypeChecker | null; generation?: ModuleGenerationService } = {}) {
  const repository = new Repository(":memory:");
  const metrics = new Metrics();
  const tutor = new TutorService(repository, options.model ?? null, silentLogger, metrics);
  const codeIndexes = new Map([["ops-triage-ai", indexRepository(originalDir(join(import.meta.dir, "../data/golden/ops-triage-ai")))]]);
  const api = createApi({ journeys: goldenJourneys(), repository, tutor, sandbox: null, typeChecker: options.typeChecker ?? null, logger: silentLogger, metrics, codeIndexes, ...(options.generation ? { generation: options.generation, targeted: new TargetedJourneyStore(mkdtempSync(join(tmpdir(), "replay-targeted-"))) } : {}) });
  const fetch = createApp(api, new Map(), silentLogger, metrics);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-learner-id": "learner-test-0001" }) =>
    fetch(
      new Request(`http://test${path}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { call, repository, metrics };
}
