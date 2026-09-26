import { test, expect } from "replay:test";
import { classify } from "./classify.ts";

const t = (title: string, description = "") => classify({ title, description });
test('"Checkout bug" → BUG', () => expect(t("Checkout bug")).toBe("BUG"));
test('"Cannot LOGIN" → ACCESS', () => expect(t("Cannot LOGIN")).toBe("ACCESS"));
test('"Site down" → INCIDENT', () => expect(t("Site down")).toBe("INCIDENT"));
test('"Login bug" → BUG (a ordem decide)', () => expect(t("Login bug")).toBe("BUG"));
test('nenhuma pista → OTHER', () => expect(t("Lunch", "menu")).toBe("OTHER"));
