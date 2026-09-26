import { join } from "node:path";
import { Repository } from "../src/db/repository.ts";
import type { Journey } from "../src/domain/journey.ts";
import { createApi } from "../src/http/api.ts";
import { createApp } from "../src/http/app.ts";
import { silentLogger } from "../src/obs/logger.ts";
import { Metrics } from "../src/obs/metrics.ts";
import { loadAllJourneys } from "../src/services/curriculum.ts";
import { TutorService, type TutorModel } from "../src/services/tutor.ts";
import type { TypeChecker } from "../src/sandbox/typecheck.ts";

export const goldenJourneys = (): Journey[] => loadAllJourneys(join(import.meta.dir, "../data/golden"));

export function golden(): Journey {
  const journey = goldenJourneys().find((j) => j.id === "ops-triage-ai");
  if (!journey) throw new Error("golden journey missing");
  return journey;
}

export function testApp(options: { model?: TutorModel; typeChecker?: TypeChecker | null } = {}) {
  const repository = new Repository(":memory:");
  const metrics = new Metrics();
  const tutor = new TutorService(repository, options.model ?? null, silentLogger, metrics);
  const api = createApi({ journeys: goldenJourneys(), repository, tutor, sandbox: null, typeChecker: options.typeChecker ?? null, logger: silentLogger, metrics });
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
