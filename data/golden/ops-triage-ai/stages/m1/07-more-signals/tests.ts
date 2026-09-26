import { test, expect } from "ownr:test";
import { classify, RULES } from "./classify.ts";

const t = (title: string, description = "") => classify({ title, description });

test("outage → INCIDENT", () => expect(t("Outage in EU")).toBe("INCIDENT"));
test("error → BUG", () => expect(t("Checkout error")).toBe("BUG"));
test("password → ACCESS", () => expect(t("Wrong password")).toBe("ACCESS"));
test("seis pistas, duas por categoria", () => {
  expect(RULES.length).toBe(6);
  expect(RULES.filter((r) => r.category === "INCIDENT").length).toBe(2);
});
