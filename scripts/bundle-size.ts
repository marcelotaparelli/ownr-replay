// Reports the minified + gzipped size of the frontend (target < 60 KB gzip).
import { join } from "node:path";
import { buildWebAssets } from "../src/web-assets.ts";

const TARGET_GZIP_BYTES = 60 * 1024;
const kb = (bytes: number): string => (bytes / 1024).toFixed(1).padStart(6) + " KB";

const assets = await buildWebAssets(join(import.meta.dir, "../web"));
let total = 0;
for (const [path, asset] of assets) {
  const raw = new TextEncoder().encode(asset.body);
  const gzip = Bun.gzipSync(raw).byteLength;
  total += gzip;
  console.log(`${path.padEnd(16)} ${kb(raw.byteLength)} raw ${kb(gzip)} gzip`);
}
console.log(`${"total".padEnd(16)} ${"".padStart(13)}     ${kb(total)} gzip (target < ${TARGET_GZIP_BYTES / 1024} KB)`);
if (total > TARGET_GZIP_BYTES) process.exit(1);
