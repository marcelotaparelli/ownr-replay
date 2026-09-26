import { test, expect } from "ownr:test";
import { scoreCategory } from "./classify.ts";

test("pista fraca no título: 1 × 2", () => expect(scoreCategory("BUG", "error", "")).toBe(2));
test("pista fraca na descrição: 1", () => expect(scoreCategory("BUG", "", "error")).toBe(1));
test("pista forte na descrição: 4", () => expect(scoreCategory("INCIDENT", "", "outage")).toBe(4));
test("soma de pistas e posições", () => expect(scoreCategory("INCIDENT", "down", "outage")).toBe(14));
test("login e password", () => expect(scoreCategory("ACCESS", "login", "password")).toBe(10));
