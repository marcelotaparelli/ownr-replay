/**
 * The Replay's instruments: prints measurements as JSON on stdout, for any external observer
 * (OWNR Habitat runs it in an isolated checkout of each revision it evaluates).
 *
 *   bun scripts/measure.ts curriculum   curriculum validity + Module 1 novelty per micro stage
 *   bun scripts/measure.ts bundle       frontend weight as the learner downloads it
 *
 * Output: { measurements: [{ metric, value, unit? }], evidence: [{ summary, detail? }], problems: string[] }.
 * Exit 0 when the instrument read the system (problems included); non-zero when it could not run.
 */
import { join } from "node:path";
import { CurriculumError, loadAllJourneys } from "../src/services/curriculum.ts";
import { noveltyReport } from "../src/services/curriculum-check.ts";
import { buildWebAssets } from "../src/web-assets.ts";

type Measurement = { metric: string; value: number; unit?: string };
export type Report = { measurements: Measurement[]; evidence: { summary: string; detail?: string }[]; problems: string[] };

const ROOT = join(import.meta.dir, "..");
const MODULE = "m1";
const ALERT_ABOVE = 5;
const JUSTIFY_FROM = 8;

export function curriculum(): Report {
  let journeys;
  try {
    journeys = loadAllJourneys(join(ROOT, "data/golden"));
  } catch (error) {
    if (!(error instanceof CurriculumError)) throw error;
    return { measurements: [{ metric: "curriculum.problems", value: error.problems.length }], evidence: [{ summary: `${error.problems.length} problema(s) no currículo` }], problems: error.problems };
  }
  const journey = journeys.find((j) => j.id === "ops-triage-ai");
  if (!journey) return { measurements: [], evidence: [], problems: ["golden journey ops-triage-ai not found"] };
  const module = journey.stages.filter((s) => s.moduleId === MODULE);
  const report = noveltyReport(module);
  const lines = report.map((r) => r.newLines);
  const shown = module.flatMap((s) => s.exercise?.solutionFiles ?? []).flatMap((f) => f.content.split("\n"));
  return {
    measurements: [
      { metric: "m1.micro_stages", value: report.length },
      { metric: "m1.max_new_lines", value: Math.max(0, ...lines) },
      { metric: "m1.stages_above_5", value: lines.filter((n) => n > ALERT_ABOVE).length },
      { metric: "m1.mean_new_lines", value: lines.length ? Math.round((lines.reduce((a, b) => a + b, 0) / lines.length) * 100) / 100 : 0 },
      { metric: "m1.unjustified_large_stages", value: report.filter((r) => r.newLines >= JUSTIFY_FROM && !r.exception).length },
      { metric: "m1.concepts_introduced", value: new Set(module.flatMap((s) => s.introduces)).size },
      { metric: "m1.checkpoint_present", value: module.some((s) => s.kind === "checkpoint") ? 1 : 0 },
      // Counter-metric for the line count: packing code into long lines "reduces" novelty without reducing it.
      { metric: "m1.max_line_length", value: Math.max(0, ...shown.map((l) => l.length)) },
      { metric: "curriculum.problems", value: 0 },
    ],
    evidence: [
      {
        summary: `currículo válido; ${report.length} micro etapas no Module 1`,
        detail: report.map((r) => `${r.stageId.padEnd(22)} ${String(r.newLines).padStart(2)}  ${r.title}${r.exception ? "  [justificada]" : ""}`).join("\n"),
      },
    ],
    problems: [],
  };
}

export async function bundle(): Promise<Report> {
  const assets = await buildWebAssets(join(ROOT, "web"));
  let bytes = 0;
  for (const asset of assets.values()) bytes += Bun.gzipSync(new TextEncoder().encode(asset.body)).byteLength;
  const kb = Math.round((bytes / 1024) * 10) / 10;
  return { measurements: [{ metric: "web.bundle_gzip_kb", value: kb, unit: "KB" }], evidence: [{ summary: `bundle ${kb} KB gzip (${assets.size} arquivos)` }], problems: [] };
}

if (import.meta.main) {
  const instrument = process.argv[2];
  if (instrument !== "curriculum" && instrument !== "bundle") {
    console.error("uso: bun scripts/measure.ts <curriculum|bundle>");
    process.exit(2);
  }
  console.log(JSON.stringify(instrument === "curriculum" ? curriculum() : await bundle()));
}
