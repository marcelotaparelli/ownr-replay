import { test, expect } from "replay:test";
import { classify } from "./classify.ts";

const t = (title: string, description = "") => classify({ title, description });

test("mais pistas vence: ACCESS 2 × BUG 1", () => expect(t("Cannot login", "after password reset the page shows a bug")).toBe("ACCESS"));
test("uma pista basta", () => expect(t("Site down")).toBe("INCIDENT"));
test("nenhuma pista → OTHER", () => expect(t("Lunch", "menu")).toBe("OTHER"));
test("empate → a primeira da ordem (INCIDENT antes de BUG)", () => expect(t("bug", "outage")).toBe("INCIDENT"));
