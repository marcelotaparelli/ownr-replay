import { describe, expect, test } from "bun:test";
import { addedLines, previousVersions } from "../src/domain/line-diff.ts";
import { golden, testApp } from "./helpers.ts";

const short = (id: string) => id.split(".")[1];

describe("what changed in each stage", () => {
  const journey = golden();

  test("micro stages keep comparing with the previous micro stage (unchanged behaviour)", () => {
    const micro = journey.stages.filter((s) => s.kind === "micro");
    for (const [i, stage] of micro.entries()) {
      const previous = previousVersions(journey.stages, stage.id);
      if (i === 0) expect(previous).toEqual([]);
      else expect(previous.map((p) => [p.path, short(p.stageId)])).toEqual([["classify.ts", short(micro[i - 1]?.id ?? "")]]);
    }
  });

  test("chapters compare each file with the last stage that showed it, however far back", () => {
    const byStage = (id: string) => Object.fromEntries(previousVersions(journey.stages, `ops-triage-ai.${id}`).map((p) => [p.path, short(p.stageId)]));
    expect(byStage("02")).toEqual({});
    expect(byStage("03")).toEqual({ "triage.ts": "02" });
    // triage-classifier.ts is not shown in 03: its previous version is the one from 02.
    expect(byStage("04")).toEqual({ "triage-classifier.ts": "02" });
    expect(byStage("05")).toEqual({ "triage-ticket.ts": "02", "triage-decision.ts": "03" });
    expect(byStage("m1-99")).toEqual({ "classify.ts": "m1-17" });
  });

  test("every module 2–8 stage has something highlighted: changed lines, or files it introduces", () => {
    for (const stage of journey.stages.filter((s) => s.kind === "chapter")) {
      const previous = previousVersions(journey.stages, stage.id);
      const highlighted = stage.referenceCode.map((f) => addedLines(previous.find((p) => p.path === f.path)?.content ?? "", f.content).length);
      expect({ stage: short(stage.id), any: highlighted.some((n) => n > 0) }).toEqual({ stage: short(stage.id), any: true });
    }
  });

  test("only real novelty is highlighted: formatting and indentation changes are not", () => {
    expect(addedLines("export function a() {\n  return 1;\n}", "export  function a()   {\n\treturn 1;\n}\n")).toEqual([]);
    expect(addedLines("export function a() {\n  return 1;\n}", "export function a() {\n  return 2;\n}")).toEqual([2]);
  });

  test("the stage API ships the previous version of each shown file", async () => {
    const { call } = testApp();
    const response = await call("GET", "/api/stages/ops-triage-ai.05");
    const body = (await response.json()) as { previousCode: { path: string; stageId: string; content: string }[] };
    expect(body.previousCode.map((p) => [p.path, short(p.stageId)])).toEqual([
      ["triage-ticket.ts", "02"],
      ["triage-decision.ts", "03"],
    ]);
    expect(body.previousCode.every((p) => p.content.length > 0)).toBe(true);
  });
});
