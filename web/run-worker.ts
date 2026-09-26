/// <reference lib="webworker" />
// Development BrowserRunner: executes learner code inside the learner's own
// browser, in a disposable worker. It is NOT a security boundary — it only
// guarantees that nothing learner-written ever runs on the server.
import type { ModuleSet } from "../src/sandbox/modules.ts";
import { executeModules } from "../src/sandbox/execute.ts";

self.addEventListener("message", (event: MessageEvent<ModuleSet>) => {
  executeModules(event.data).then(
    (result) => self.postMessage({ ok: true, result }),
    (error: unknown) => self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
});
