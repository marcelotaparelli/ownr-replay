import { expect, test } from "bun:test";
import { bundle, curriculum } from "../scripts/measure.ts";

// The instruments external observers (OWNR Habitat) read: they must describe the real curriculum.
test("curriculum instrument measures Module 1 without problems", () => {
  const report = curriculum();
  expect(report.problems).toEqual([]);
  const byMetric = new Map(report.measurements.map((m) => [m.metric, m.value]));
  expect(byMetric.get("m1.checkpoint_present")).toBe(1);
  expect(byMetric.get("m1.unjustified_large_stages")).toBe(0);
  expect(byMetric.get("m1.micro_stages")).toBeGreaterThan(10);
  expect(byMetric.get("m1.max_line_length")).toBeLessThanOrEqual(100);
});

test("bundle instrument reports the gzip weight of the frontend", async () => {
  const [weight] = (await bundle()).measurements;
  expect(weight?.metric).toBe("web.bundle_gzip_kb");
  expect(weight?.value).toBeGreaterThan(0);
});
