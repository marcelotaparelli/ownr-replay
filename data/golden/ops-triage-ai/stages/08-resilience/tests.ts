import { test, expect } from "ownr:test";
import { Metrics, logLine, metricKey } from "./observability.ts";
import { ConcurrencyLimiter, withTimeout } from "./resilience.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("o limiter aceita até o limite e recusa o resto", () => {
  const limiter = new ConcurrencyLimiter(2);
  expect([limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire()]).toEqual([true, true, false]);
  limiter.release();
  expect(limiter.tryAcquire()).toBe(true);
});

test("release a mais não cria vagas fantasmas", () => {
  const limiter = new ConcurrencyLimiter(1);
  limiter.release();
  limiter.release();
  expect([limiter.tryAcquire(), limiter.tryAcquire()]).toEqual([true, false]);
});

test("withTimeout devolve o resultado quando chega a tempo", async () => {
  expect(await withTimeout(sleep(5).then(() => "ok"), 200)).toBe("ok");
});

test("withTimeout rejeita com request_timeout quando demora demais", async () => {
  const started = Date.now();
  let message = "";
  try {
    await withTimeout(sleep(500), 20);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message).toBe("request_timeout");
  expect(Date.now() - started).toBeLessThan(300);
});

test("withTimeout repassa o erro original", async () => {
  await expect(() => withTimeout(Promise.reject(new RangeError("x")), 100)).rejects.toBeInstanceOf(RangeError);
});

test("chave de métrica: labels ordenados formam uma série só", () => {
  expect(metricKey("requests_total", {})).toBe("requests_total");
  expect(metricKey("requests_total", { status: "201", route: "POST /tickets/triage" })).toBe("requests_total{route=POST /tickets/triage,status=201}");
  const metrics = new Metrics();
  metrics.increment("triage_total", { source: "HYBRID", review: "yes" });
  metrics.increment("triage_total", { review: "yes", source: "HYBRID" });
  expect(metrics.snapshot()).toEqual({ "triage_total{review=yes,source=HYBRID}": 2 });
});

test("log é uma linha JSON com evento e campos", () => {
  expect(JSON.parse(logLine("info", "triage_completed", { durationMs: 12 }))).toEqual({ level: "info", event: "triage_completed", durationMs: 12 });
});
