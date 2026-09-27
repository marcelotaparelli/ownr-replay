import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type Asset } from "../http/app.ts";
import { logger } from "../obs/logger.ts";
import { Metrics } from "../obs/metrics.ts";
import { createHabitatApi, snapshot } from "./http.ts";
import { createReplayHabitat, loadHabitatConfig } from "./replay/compose.ts";

/**
 * OWNR Habitat — `bun src/habitat/main.ts <serve|observe|evolve <proposal>|status>`.
 * Runs next to the Replay (its own port, its own database) and only ever reads the
 * Replay's data. The CLI and the server share habitat.sqlite; run one job at a time.
 */
const root = join(import.meta.dir, "../..");
const config = loadHabitatConfig();
const deps = { ...createReplayHabitat(root, config, logger), logger };
const [command = "serve", arg] = process.argv.slice(2);

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

switch (command) {
  case "serve": {
    // Loopback only: this server can start commands on the host.
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
    console.log(`\n${candidate.id} → ${decision.verdict} (${candidate.status})`);
    for (const reason of decision.reasons) console.log(`  · ${reason}`);
    break;
  }
  case "status":
    printStatus(await snapshot(deps));
    break;
  default:
    throw new Error(`comando desconhecido: ${command}`);
}

function printStatus(state: Awaited<ReturnType<typeof snapshot>>): void {
  console.log(`\n${state.organism.name} · missão ${state.mission.id}: ${state.mission.objective}`);
  for (const p of state.progress) console.log(`  ${p.status.padEnd(17)} ${p.label}: ${p.value ?? "—"} (alvo ${p.operator} ${p.target}${p.sampleSize === undefined ? "" : `, amostra ${p.sampleSize}`})`);
  console.log(`baseline: ${state.baseline ? `${state.baseline.revision.slice(0, 8)} (${state.baseline.id})` : "não observada"}`);
  for (const c of state.candidates) console.log(`  ${c.id} ${c.proposalId.padEnd(24)} ${c.status.padEnd(11)} ${c.verdict ?? ""}`);
}
