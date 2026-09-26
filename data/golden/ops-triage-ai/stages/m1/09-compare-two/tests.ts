import { test, expect } from "ownr:test";
import { classify } from "./classify.ts";

const t = (title: string, description = "") => classify({ title, description });

test("ACCESS 2 × BUG 1 → ACCESS", () => expect(t("Cannot login", "after password reset the page shows a bug")).toBe("ACCESS"));
test("o resto continua igual", () => {
  expect(t("Site down")).toBe("INCIDENT");
  expect(t("Checkout bug")).toBe("BUG");
  expect(t("Lunch", "menu")).toBe("OTHER");
});
