import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Asset } from "./http/app.ts";

/** Bundles the vanilla-TS frontend in memory at startup (no build step, no dist/). */
const ENTRYPOINTS = ["app", "run-worker"] as const;

export async function buildWebAssets(webDir: string): Promise<Map<string, Asset>> {
  const assets = new Map<string, Asset>();
  // One build per entry: each output is a single self-contained file, no chunk naming to resolve.
  for (const name of ENTRYPOINTS) {
    const result = await Bun.build({ entrypoints: [join(webDir, `${name}.ts`)], target: "browser", minify: true });
    const output = result.outputs[0];
    if (!result.success || !output) {
      throw new Error("Frontend build failed:\n" + result.logs.map(String).join("\n"));
    }
    assets.set(`/${name}.js`, { body: await output.text(), type: "text/javascript; charset=utf-8" });
  }
  assets.set("/index.html", { body: readFileSync(join(webDir, "index.html"), "utf8"), type: "text/html; charset=utf-8" });
  assets.set("/styles.css", { body: readFileSync(join(webDir, "styles.css"), "utf8"), type: "text/css; charset=utf-8" });
  return assets;
}
