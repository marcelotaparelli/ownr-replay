import { test, expect, afterEach } from "bun:test";
import { lastRepoUrl, rememberRepoUrl } from "../web/store.ts";

/** Regression: the home form used to restart from the sample repository on every visit, so a second
 *  request silently went to ops-triage-ai after the first one had gone to another repository. */
const globals = globalThis as { localStorage?: unknown };
const install = (storage: unknown): void => { globals.localStorage = storage; };
const memoryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
};
afterEach(() => { delete globals.localStorage; });

test("lembra o último repositório usado entre visitas à home", () => {
  install(memoryStorage());
  expect(lastRepoUrl()).toBeUndefined();
  rememberRepoUrl("https://github.com/marcelotaparelli/resilient-transaction-api");
  expect(lastRepoUrl()).toBe("https://github.com/marcelotaparelli/resilient-transaction-api");
  rememberRepoUrl("https://github.com/marcelotaparelli/ops-triage-ai");
  expect(lastRepoUrl()).toBe("https://github.com/marcelotaparelli/ops-triage-ai");
});

test("só guarda URLs do GitHub e ignora lixo já armazenado", () => {
  const storage = memoryStorage();
  install(storage);
  rememberRepoUrl("http://evil.example/x");
  rememberRepoUrl("not a url");
  expect(lastRepoUrl()).toBeUndefined();
  storage.setItem("rr:v1:repo-url", JSON.stringify({ not: "a string" }));
  expect(lastRepoUrl()).toBeUndefined();
});

test("sem armazenamento disponível a home continua funcionando", () => {
  install({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(() => rememberRepoUrl("https://github.com/marcelotaparelli/ops-triage-ai")).not.toThrow();
  expect(lastRepoUrl()).toBeUndefined();
});
