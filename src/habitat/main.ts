import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type Asset } from "../http/app.ts";
import { logger } from "../obs/logger.ts";
import { Metrics } from "../obs/metrics.ts";
import type { Decision } from "./domain.ts";
import { createHabitatApi, snapshot } from "./http.ts";
import { createReplayHabitat, loadHabitatConfig } from "./replay/compose.ts";

/**
 * OWNR Habitat — bun src/habitat/main.ts <command>
 *   serve | observe | status | evolve <proposal> | reevaluate <candidate>
 *   accept <candidate> --by <name>      (human act: the candidate becomes the new baseline)
 *   revise-mission --by <name>          (human act: adopt a changed mission definition)
 * Runs next to the Replay (its own port and database) and only reads the Replay's data.
 * The CLI and the server share habitat.sqlite; run one job at a time.
 */
const root = join(import.meta.dir, "../..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const [command = "serve", arg] = args;
const by = flag("--by");
if ((command === "accept" || command === "revise-mission") && (!by || by.trim().length < 2)) throw new Error(`${command} exige --by <nome de quem decide>`);

const config = loadHabitatConfig();
const deps = { ...createReplayHabitat(root, config, logger, command === "revise-mission" && by ? { reviseMissionBy: by } : {}), logger };

async function cockpitAssets(): Promise<Map<string, Asset>> {
  const dir = join(root, "web/habitat");
  const result = await Bun.build({ entrypoints: [join(dir, "cockpit.ts")], target: "browser", minify: true });
  const output = result.outputs[0];
  if (!result.success || !output) throw new Error("Cockpit build failed:\n" + result.logs.map(String).join("\n"));
  return new Map([
    ["/cockpit.js", { body: await output.text(), type: "text/javascript; charset=utf-8" }],
    ["/index.html", { body: readFileSync(join(dir, "index.html"), "utf8"), type: "text/html; charset=utf-8" }],
    ["/cockpit.css", { body: readFileSync(join(dir, "cockpit.css"), "utf8"), type: "text/css; charset=utf-8" }],
  ]);
}

const printDecision = (id: string, decision: Decision): void => {
  console.log(`\n${id} → ${decision.verdict}`);
  for (const reason of decision.reasons) console.log(`  · ${reason}`);
  for (const warning of decision.warnings) console.log(`  ! ${warning}`);
};

switch (command) {
  case "serve": {
    // Loopback only: this server can start commands on the host and move the baseline branch.
    const server = Bun.serve({ hostname: "127.0.0.1", port: config.HABITAT_PORT, fetch: createApp(createHabitatApi(deps), await cockpitAssets(), logger, new Metrics()) });
    logger.info("habitat_started", { url: server.url.toString(), organism: deps.organism.id, mission: deps.habitat.mission.id });
    const shutdown = (): void => {
      server.stop();
      deps.store.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    break;
  }
  case "observe": {
    const { observationId } = await deps.habitat.observeBaseline();
    console.log(`observação ${observationId}`);
    printStatus(await snapshot(deps));
    break;
  }
  case "evolve": {
    if (!arg) throw new Error("uso: evolve <proposal-id>");
    const { candidate, decision } = await deps.habitat.evolve(arg);
    printDecision(candidate.id, decision);
    break;
  }
  case "reevaluate": {
    if (!arg) throw new Error("uso: reevaluate <candidate-id>");
    const { candidate, decision } = await deps.habitat.reevaluate(arg);
    console.log(`${candidate.id} reavalia ${arg} contra ${candidate.parentRevision.slice(0, 10)}`);
    printDecision(candidate.id, decision);
    break;
  }
  case "accept": {
    if (!arg || !by) throw new Error("uso: accept <candidate-id> --by <nome>");
    const { from, to } = await deps.habitat.accept(arg, by);
    console.log(`baseline ${from.slice(0, 10)} → ${to.slice(0, 10)} (aceito por ${by}). Observe a nova baseline.`);
    break;
  }
  case "revise-mission":
    console.log(`missão ${deps.habitat.mission.id} na revisão atual; evidências de revisões anteriores ficam STALE.`);
    break;
  case "status":
    printStatus(await snapshot(deps));
    break;
  default:
    throw new Error(`comando desconhecido: ${command}`);
}

function printStatus(state: Awaited<ReturnType<typeof snapshot>>): void {
  console.log(`\n${state.organism.name} · missão ${state.mission.id} (revisão ${state.context.missionRevision}): ${state.mission.objective}`);
  for (const p of state.progress) console.log(`  ${p.status.padEnd(17)} ${p.label}: ${p.value ?? "—"} (alvo ${p.operator} ${p.target}${p.sampleSize === undefined ? "" : `, amostra ${p.sampleSize}`})`);
  console.log(`baseline atual: ${state.context.baselineRevision.slice(0, 10)} · observada: ${state.baseline ? `${state.baseline.revision.slice(0, 10)} (${state.baseline.id})${state.baseline.current ? "" : " — DESATUALIZADA"}` : "não"}`);
  for (const b of state.baselines) console.log(`  baseline ${b.revision.slice(0, 10)} ${b.acceptedCandidate ? `← ${b.acceptedCandidate} (${b.assessment})` : ""}`);
  for (const c of state.candidates) {
    console.log(`  g${c.generation} ${c.id} ${c.proposalId.padEnd(22)} ${c.status.padEnd(10)} ${(c.verdict ?? "").padEnd(17)}${c.verdict === "STALE" ? ` (era ${c.recordedVerdict}: ${c.stale[0]})` : ""}${c.reevaluationOf ? ` reavalia ${c.reevaluationOf}` : ""}`);
  }
}
