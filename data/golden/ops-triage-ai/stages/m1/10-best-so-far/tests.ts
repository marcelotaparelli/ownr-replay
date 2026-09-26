import { test, expect } from "ownr:test";
import { classify } from "./classify.ts";

const t = (title: string, description = "") => classify({ title, description });

test("BUG 2 × INCIDENT 1 → BUG", () => expect(t("Checkout down", "error: bug found")).toBe("BUG"));
test("ACCESS 2 × BUG 1 → ACCESS", () => expect(t("Cannot login", "after password reset the page shows a bug")).toBe("ACCESS"));
test("nenhuma pista → OTHER", () => expect(t("Lunch", "menu")).toBe("OTHER"));
test("empate → a primeira da ordem (INCIDENT antes de BUG)", () => expect(t("bug", "outage")).toBe("INCIDENT"));
