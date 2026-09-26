import { test, expect } from "replay:test";
import { classify, RULES } from "./classify.ts";

const t = (title: string, description = "") => classify({ title, description });
test("mesmo comportamento: bug, login, down, ordem, OTHER", () => {
  expect(t("Checkout bug")).toBe("BUG");
  expect(t("Cannot login")).toBe("ACCESS");
  expect(t("Site down")).toBe("INCIDENT");
  expect(t("Login bug")).toBe("BUG");
  expect(t("Lunch")).toBe("OTHER");
});
test("RULES é uma lista de { word, category }", () => {
  expect(RULES.map((r) => r.word)).toEqual(["down", "bug", "login"]);
});
test("uma regra nova na lista muda o resultado sem mexer na função", () => {
  RULES.push({ word: "outage", category: "INCIDENT" });
  expect(t("Outage in EU")).toBe("INCIDENT");
});
