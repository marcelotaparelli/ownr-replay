import { test, expect } from "replay:test";
import { classify } from "./classify.ts";

const t = (title: string, description = "") => classify({ title, description });
test("empate ACCESS × BUG → ACCESS", () => expect(t("", "login fails with a bug error")).toBe("ACCESS"));
test("título pesa: BUG", () => expect(t("Checkout bug", "")).toBe("BUG"));
test("incidente", () => expect(t("Site DOWN", "")).toBe("INCIDENT"));
test("nada → OTHER", () => expect(t("Lunch", "menu")).toBe("OTHER"));
