import { test, expect } from "replay:test";
import { scoreCategory } from "./score.ts";

test("pista no título vale 2", () => expect(scoreCategory("BUG", "bug in checkout", "")).toBe(2));
test("pista na descrição vale 1", () => expect(scoreCategory("BUG", "", "bug in checkout")).toBe(1));
test("título e descrição somam", () => expect(scoreCategory("ACCESS", "cannot login", "password reset")).toBe(3));
test("outra categoria não conta", () => expect(scoreCategory("INCIDENT", "cannot login", "password reset")).toBe(0));
