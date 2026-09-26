import { test, expect } from "replay:test";
import { classify } from "./classify.ts";

const t = (title: string, description = "") => classify({ title, description });

test("empate ACCESS × BUG → ACCESS", () => expect(t("", "login fails with a bug error")).toBe("ACCESS"));
test("empate INCIDENT × ACCESS → INCIDENT", () => expect(t("", "outage login")).toBe("INCIDENT"));
test("sem empate, maior placar vence", () => expect(t("Checkout bug", "")).toBe("BUG"));
test("nada → OTHER", () => expect(t("Lunch", "menu")).toBe("OTHER"));
