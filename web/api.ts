import type { JourneyOutline } from "../src/domain/journey.ts";
import type { PreviousVersion } from "../src/domain/line-diff.ts";
import type { LearningGoal } from "../src/domain/learning-goal.ts";
import type { KnowledgeLevel, ProgressUpdate, RunResult, StageProgress } from "../src/domain/progress.ts";
import type { CodeFile, Stage } from "../src/domain/stage.ts";
import type { TutorReply, TutorSelection } from "../src/domain/tutor.ts";
import type { ModuleSet } from "../src/sandbox/modules.ts";

export type StageDetail = Stage & { runner: "browser" | "docker"; previousCode: PreviousVersion[] };
export type TypeDiagnostic = { file: string; line: number; code: string; message: string };
export type RunResponse =
  | ({ mode: "browser"; typecheck?: "passed" } & ModuleSet)
  | { mode: "server"; typecheck?: "passed"; result: RunResult }
  | { mode: "typecheck"; diagnostics: TypeDiagnostic[] };
export type JourneyCard = Pick<JourneyOutline, "id" | "title" | "description" | "repo" | "status"> & { stageCount: number };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The full error body, for errors that carry an alternative (e.g. a fallback journey). */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

const LEARNER_KEY = "rr:v1:learner"; // identity survives content resets
const REQUEST_TIMEOUT_MS = 15_000;
const TUTOR_TIMEOUT_MS = 90_000;

export const learnerId: string = (() => {
  try {
    const existing = localStorage.getItem(LEARNER_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(LEARNER_KEY, created);
    return created;
  } catch {
    // Storage blocked (private mode): progress still works for this tab only.
    return crypto.randomUUID();
  }
})();

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const response = await fetch(path, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "x-learner-id": learnerId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = isErrorBody(payload) ? payload.error : { code: "HTTP_" + response.status, message: "Falha na requisição." };
    throw new ApiError(response.status, error.code, error.message, payload);
  }
  return payload as T;
}

function isErrorBody(value: unknown): value is { error: { code: string; message: string } } {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = value.error;
  return typeof error === "object" && error !== null && "code" in error && "message" in error;
}

export const api = {
  journeys: () => request<JourneyCard[]>("GET", "/api/journeys"),
  journey: (id: string) => request<JourneyOutline>("GET", `/api/journeys/${encodeURIComponent(id)}`),
  createJourney: (repoUrl: string, goal: LearningGoal) => request<{ id: string }>("POST", "/api/journeys", { repoUrl, goal }),
  progress: (journeyId: string) =>
    request<{ stages: StageProgress[]; knowledge: { conceptId: string; state: KnowledgeLevel }[] }>(
      "GET",
      `/api/journeys/${encodeURIComponent(journeyId)}/progress`,
    ),
  setKnowledge: (journeyId: string, conceptIds: string[], state: KnowledgeLevel) =>
    request<{ ok: true }>("POST", `/api/journeys/${encodeURIComponent(journeyId)}/knowledge`, { conceptIds, state }),
  stage: (id: string) => request<StageDetail>("GET", `/api/stages/${encodeURIComponent(id)}`),
  run: (stageId: string, files: CodeFile[]) => request<RunResponse>("POST", `/api/stages/${encodeURIComponent(stageId)}/run`, { files }),
  attempt: (stageId: string, result: RunResult) =>
    request<{ ok: true; firstPass: boolean }>("POST", `/api/stages/${encodeURIComponent(stageId)}/attempts`, { runner: "browser", result }),
  tutor: (stageId: string, message: string, selection?: TutorSelection, threadId?: string) =>
    request<TutorReply>(
      "POST",
      `/api/stages/${encodeURIComponent(stageId)}/tutor`,
      { message, ...(selection ? { selection } : {}), ...(threadId ? { threadId } : {}) },
      TUTOR_TIMEOUT_MS,
    ),
  progressUpdate: (stageId: string, update: ProgressUpdate) =>
    request<{ ok: true }>("POST", `/api/stages/${encodeURIComponent(stageId)}/progress`, update),
  event: (stageId: string, type: "stage_opened" | "explanation_depth" | "solution_revealed" | "checkpoint_revealed" | "reconstruct_started", data?: Record<string, string | number | boolean>) =>
    request<{ ok: true }>("POST", `/api/stages/${encodeURIComponent(stageId)}/events`, { type, ...(data ? { data } : {}) }),
};
