import { describe, expect, test } from "bun:test";
import type { TutorModel } from "../src/services/tutor.ts";
import { golden, testApp } from "./helpers.ts";

const stage = golden().stages[0];
if (!stage?.exercise) throw new Error("stage 1 exercise missing");
const learnerFile = stage.exercise.starterFiles[0]?.path ?? "";
const solution = stage.exercise.solutionFiles;

describe("stage flow", () => {
  test("journey → stage → run → attempt → progress", async () => {
    const { call } = testApp();
    expect((await call("GET", "/api/journeys/ops-triage-ai")).status).toBe(200);
    const detail = await (await call("GET", `/api/stages/${stage.id}`)).json();
    expect(detail.runner).toBe("browser");

    const run = await call("POST", `/api/stages/${stage.id}/run`, { files: solution });
    expect(run.status).toBe(200);
    expect((await run.json()).mode).toBe("browser");

    const result = { stdout: "", latencyMs: 12, tests: [{ name: "a", passed: true }] };
    const first = await (await call("POST", `/api/stages/${stage.id}/attempts`, { runner: "browser", result })).json();
    expect(first.firstPass).toBe(true);
    const second = await (await call("POST", `/api/stages/${stage.id}/attempts`, { runner: "browser", result })).json();
    expect(second.firstPass).toBe(false);

    expect((await call("POST", `/api/stages/${stage.id}/progress`, { status: "completed", timeSpentMs: 5_000 })).status).toBe(200);
    const progress = await (await call("GET", "/api/journeys/ops-triage-ai/progress")).json();
    expect(progress.stages[0]).toMatchObject({ stageId: stage.id, status: "completed", timeSpentMs: 5_000 });
  });

  test("skipped_known is distinct from completed and marks the stage's concepts as known", async () => {
    const { call } = testApp();
    await call("POST", `/api/stages/${stage.id}/progress`, { status: "skipped_known", knownConcepts: stage.introduces });
    const progress = await (await call("GET", "/api/journeys/ops-triage-ai/progress")).json();
    expect(progress.stages[0].status).toBe("skipped_known");
    expect(progress.knowledge.map((k: { conceptId: string }) => k.conceptId).sort()).toEqual([...stage.introduces].sort());
  });

  test("progress is per learner", async () => {
    const { call } = testApp();
    await call("POST", `/api/stages/${stage.id}/progress`, { status: "completed" });
    const other = await (await call("GET", "/api/journeys/ops-triage-ai/progress", undefined, { "x-learner-id": "someone-else-0001" })).json();
    expect(other.stages).toEqual([]);
  });
});

describe("empty-editor exercises", () => {
  test("the learner writes plain code: no export needed", async () => {
    const { call } = testApp();
    const files = [{ path: learnerFile, content: `function classify(text: string) {\n  return "INCIDENT";\n}` }];
    const response = await call("POST", `/api/stages/${stage.id}/run`, { files });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.modules.find((m: { path: string }) => m.path === learnerFile).code).toContain("export");
  });

  test("a missing function is reported by name, not as a crash", async () => {
    const { call } = testApp();
    const response = await call("POST", `/api/stages/${stage.id}/run`, { files: [{ path: learnerFile, content: "" }] });
    expect(response.status).toBe(422);
    expect((await response.json()).error.message).toContain("`classify`");
  });

  test("syntax errors point to the line", async () => {
    const { call } = testApp();
    const response = await call("POST", `/api/stages/${stage.id}/run`, { files: [{ path: learnerFile, content: "function classify(text {\n  return 1\n}" }] });
    expect((await response.json()).error.message).toMatch(/linha \d+/);
  });
});

describe("boundaries", () => {
  test("errors have a consistent shape and a request id", async () => {
    const { call } = testApp();
    const response = await call("GET", "/api/stages/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.json()).toEqual({ error: { code: "STAGE_NOT_FOUND", message: "Stage não encontrada." } });
  });

  test("learner routes require a learner id", async () => {
    const { call } = testApp();
    expect((await call("GET", "/api/journeys/ops-triage-ai/progress", undefined, {})).status).toBe(401);
  });

  test("only exercise files may be run", async () => {
    const { call } = testApp();
    const response = await call("POST", `/api/stages/${stage.id}/run`, { files: [{ path: "other.ts", content: "" }] });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("UNEXPECTED_FILE");
  });

  test("external imports are rejected before anything runs", async () => {
    const { call } = testApp();
    const files = [{ path: learnerFile, content: `import { $ } from "bun"; export const x = $;` }];
    const response = await call("POST", `/api/stages/${stage.id}/run`, { files });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("MODULE_REJECTED");
  });

  test("oversized source is refused", async () => {
    const { call } = testApp();
    const response = await call("POST", `/api/stages/${stage.id}/run`, { files: [{ path: learnerFile, content: "x".repeat(70_000) }] });
    expect(response.status).toBe(413);
  });

  test("invalid status values are refused", async () => {
    const { call } = testApp();
    const response = await call("POST", `/api/stages/${stage.id}/progress`, { status: "done" });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
  });

  test("non-JSON bodies are refused", async () => {
    const { call } = testApp();
    const response = await call("POST", `/api/stages/${stage.id}/progress`, undefined, { "x-learner-id": "learner-test-0001", "content-type": "text/plain" });
    expect(response.status).toBe(415);
  });
});

describe("tutor", () => {
  test("works without any LLM configured", async () => {
    const { call } = testApp();
    const reply = await (await call("POST", `/api/stages/${stage.id}/tutor`, { message: "onde isso está no projeto real?" })).json();
    expect(reply.source).toBe("offline");
    expect(reply.reply).toContain("checkpoint do módulo");
  });

  test("uses the configured model, keeps the thread, and falls back offline when it fails", async () => {
    const seen: number[] = [];
    let fail = false;
    const model: TutorModel = {
      complete: async ({ messages }) => {
        seen.push(messages.length);
        if (fail) throw new Error("down");
        return "resposta do modelo";
      },
    };
    const { call } = testApp({ model });
    const first = await (await call("POST", `/api/stages/${stage.id}/tutor`, { message: "por que um enum?" })).json();
    expect(first).toMatchObject({ reply: "resposta do modelo", source: "llm" });
    await call("POST", `/api/stages/${stage.id}/tutor`, { message: "e o Record?", threadId: first.threadId });
    expect(seen).toEqual([1, 3]);

    fail = true;
    const fallback = await (await call("POST", `/api/stages/${stage.id}/tutor`, { message: "onde isso está no projeto real?" })).json();
    expect(fallback.source).toBe("offline");
  });

  test("a thread id from another learner does not leak history", async () => {
    const seen: number[] = [];
    const model: TutorModel = { complete: async ({ messages }) => (seen.push(messages.length), "ok") };
    const { call } = testApp({ model });
    const mine = await (await call("POST", `/api/stages/${stage.id}/tutor`, { message: "segredo" })).json();
    await call("POST", `/api/stages/${stage.id}/tutor`, { message: "oi", threadId: mine.threadId }, { "x-learner-id": "intruder-00001" });
    expect(seen).toEqual([1, 1]);
  });
});
