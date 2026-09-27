import { describe, expect, test } from "bun:test";
import { addedLines, highlightedLines, previousVersions, stageCodeHighlights } from "../src/domain/line-diff.ts";
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

  test("every chapter highlights its actual changes, including novel lines in new files", () => {
    for (const stage of journey.stages.filter((s) => s.kind === "chapter")) {
      const highlighted = stageCodeHighlights(journey.stages, stage.id);
      expect({ stage: short(stage.id), any: Object.values(highlighted).some((lines) => lines.length > 0) }).toEqual({ stage: short(stage.id), any: true });
    }
  });

  test("a new file highlights only two genuinely new lines against all earlier code", () => {
    const stages = [
      { id: "first", title: "First", order: 1, referenceCode: [{ path: "old.ts", content: "export const old = 1;\nexport const shared = 2;" }] },
      { id: "second", title: "Second", order: 2, referenceCode: [{ path: "other.ts", content: "export const more = 3;" }] },
      { id: "third", title: "Third", order: 3, referenceCode: [{ path: "new.ts", content: "export  const old = 1;\nexport const fresh = 4;\nexport const more = 3;\nexport const another = 5;" }] },
    ];
    expect(stageCodeHighlights(stages, "first")).toEqual({ "old.ts": [] });
    expect(stageCodeHighlights(stages, "third")).toEqual({ "new.ts": [2, 4] });
  });

  test("unchanged and whitespace-only files have no green lines", () => {
    const stages = [
      { id: "first", title: "First", order: 1, referenceCode: [{ path: "same.ts", content: "export const value = 1;" }] },
      { id: "second", title: "Second", order: 2, referenceCode: [{ path: "same.ts", content: "export const value = 1;" }] },
      { id: "third", title: "Third", order: 3, referenceCode: [{ path: "same.ts", content: "export  const value = 1;\n" }] },
    ];
    expect(stageCodeHighlights(stages, "second")).toEqual({ "same.ts": [] });
    expect(stageCodeHighlights(stages, "third")).toEqual({ "same.ts": [] });
  });

  test("only real novelty is highlighted: formatting and indentation changes are not", () => {
    expect(addedLines("export function a() {\n  return 1;\n}", "export  function a()   {\n\treturn 1;\n}\n")).toEqual([]);
    expect(addedLines("export function a() {\n  return 1;\n}", "export function a() {\n  return 2;\n}")).toEqual([2]);
  });

  test("a valid baseline highlights only its real delta, never the whole file", () => {
    const before = "export function classify(text: string) {\n  const normalized = text.toLowerCase();\n  return normalized;\n}\n";
    const current = "export function classify(text: string) {\n  const normalized = text.toLowerCase();\n  const category = normalized.includes('urgent') ? 'urgent' : 'normal';\n  return category;\n}\n";
    expect(highlightedLines(before, current)).toEqual([3, 4]);
    expect(highlightedLines(before, before)).toEqual([]);
    expect(highlightedLines(before, "export  function classify(text: string) {\n\tconst normalized = text.toLowerCase();\n  return normalized;\n}\n")).toEqual([]);
    expect(highlightedLines(undefined, current)).toEqual([]);
  });

  test("the real classifier contract changes only two lines in chapter 4", () => {
    const stage = journey.stages.find((s) => s.id === "ops-triage-ai.04");
    const file = stage?.referenceCode.find((f) => f.path === "triage-classifier.ts");
    const previous = previousVersions(journey.stages, stage?.id ?? "").find((p) => p.path === file?.path);
    expect(previous?.stageId).toBe("ops-triage-ai.02");
    expect(stageCodeHighlights(journey.stages, stage?.id ?? "")["triage-classifier.ts"]).toEqual([1, 4]);
  });

  test("the stage API ships the previous version of each shown file", async () => {
    const { call } = testApp();
    const response = await call("GET", "/api/stages/ops-triage-ai.05");
    const body = (await response.json()) as { previousCode: { path: string; stageId: string; content: string }[]; codeHighlights: Record<string, number[]> };
    expect(body.previousCode.map((p) => [p.path, short(p.stageId)])).toEqual([
      ["triage-ticket.ts", "02"],
      ["triage-decision.ts", "03"],
    ]);
    expect(body.previousCode.every((p) => p.content.length > 0)).toBe(true);
    expect(body.codeHighlights).toEqual(stageCodeHighlights(journey.stages, "ops-triage-ai.05"));
  });
});
