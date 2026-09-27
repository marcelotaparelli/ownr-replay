import { join } from "node:path";
import type { EvaluationResult, Measurement } from "../domain.ts";
import type { EvaluationContext, Evaluator } from "../ports.ts";
// Adapters over the Replay's own validators. They are imported from the CONTROL PLANE
// checkout (this process), and only read the candidate's data: a candidate cannot change them.
import { CurriculumError, loadAllJourneys } from "../../services/curriculum.ts";
import { noveltyReport } from "../../services/curriculum-check.ts";
import { buildWebAssets } from "../../web-assets.ts";

const MODULE = "m1";
const ALERT_ABOVE = 5;
const JUSTIFY_FROM = 8;

/**
 * The Replay curriculum, validated independently of the candidate's test code, plus the
 * pedagogical-complexity measurements the mission optimizes (novelty per micro stage).
 */
export class ReplayCurriculumEvaluator implements Evaluator {
  readonly id = "replay-curriculum";
  readonly version = `1;module=${MODULE};alert>${ALERT_ABOVE};justify>=${JUSTIFY_FROM};max-line-length`;

  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    const started = performance.now();
    try {
      const journeys = loadAllJourneys(join(context.dir, "data/golden"));
      const journey = journeys.find((j) => j.id === "ops-triage-ai");
      if (!journey) throw new Error("golden journey ops-triage-ai not found");
      const module = journey.stages.filter((s) => s.moduleId === MODULE);
      const report = noveltyReport(module);
      const lines = report.map((r) => r.newLines);
      const measurements: Measurement[] = [
        m("m1.micro_stages", report.length),
        m("m1.max_new_lines", Math.max(0, ...lines)),
        m("m1.stages_above_5", lines.filter((n) => n > ALERT_ABOVE).length),
        m("m1.mean_new_lines", lines.length ? Math.round((lines.reduce((a, b) => a + b, 0) / lines.length) * 100) / 100 : 0),
        m("m1.unjustified_large_stages", report.filter((r) => r.newLines >= JUSTIFY_FROM && !r.exception).length),
        m("m1.concepts_introduced", new Set(module.flatMap((s) => s.introduces)).size),
        m("m1.checkpoint_present", module.some((s) => s.kind === "checkpoint") ? 1 : 0),
        // Counter-metric for the line count: packing code into long lines "reduces" novelty without reducing it.
        m("m1.max_line_length", Math.max(0, ...module.flatMap((s) => s.exercise?.solutionFiles ?? []).flatMap((f) => f.content.split("\n").map((l) => l.length)))),
        m("curriculum.problems", 0),
      ];
      return {
        evaluatorId: this.id,
        status: "PASS",
        measurements,
        evidence: [{ kind: "report", summary: `currículo válido; ${report.length} micro etapas no Module 1`, detail: report.map((r) => `${r.stageId.padEnd(22)} ${String(r.newLines).padStart(2)}  ${r.title}${r.exception ? "  [justificada]" : ""}`).join("\n") }],
        durationMs: Math.round(performance.now() - started),
        errors: [],
      };
    } catch (error) {
      const problems = error instanceof CurriculumError ? error.problems : [String(error)];
      return {
        evaluatorId: this.id,
        status: "FAIL",
        measurements: [m("curriculum.problems", problems.length)],
        evidence: [{ kind: "report", summary: `${problems.length} problema(s) no currículo`, detail: problems.slice(0, 40).join("\n") }],
        durationMs: Math.round(performance.now() - started),
        errors: problems.slice(0, 5),
      };
    }
  }
}

/** Frontend weight as the learner downloads it (minified + gzip), built by the control plane. */
export class ReplayBundleEvaluator implements Evaluator {
  readonly id = "replay-bundle";
  readonly version = "1;entries=app,run-worker;gzip";

  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    const started = performance.now();
    const assets = await buildWebAssets(join(context.dir, "web"));
    let bytes = 0;
    for (const asset of assets.values()) bytes += Bun.gzipSync(new TextEncoder().encode(asset.body)).byteLength;
    const kb = Math.round((bytes / 1024) * 10) / 10;
    return {
      evaluatorId: this.id,
      status: "PASS",
      measurements: [{ metric: "web.bundle_gzip_kb", value: kb, status: "MEASURED", unit: "KB" }],
      evidence: [{ kind: "report", summary: `bundle ${kb} KB gzip (${assets.size} arquivos)` }],
      durationMs: Math.round(performance.now() - started),
      errors: [],
    };
  }
}

const m = (metric: string, value: number): Measurement => ({ metric, value, status: "MEASURED" });
