// Runs inside the sandbox container: reads a prepared ModuleSet from stdin,
// executes the stage tests and prints one JSON RunResult line.
import { executeModules } from "./execute.ts";
import type { ModuleSet } from "./modules.ts";

const set = JSON.parse(await Bun.stdin.text()) as ModuleSet;
const result = await executeModules(set);
process.stdout.write("\n" + JSON.stringify(result) + "\n");
process.exit(0);
