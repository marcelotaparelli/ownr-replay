import { test, expect } from "replay:test";
import { scoreCategory } from "./score.ts";

test("duas pistas de ACCESS", () => expect(scoreCategory("ACCESS", "cannot login after password reset")).toBe(2));
test("nenhuma pista de BUG", () => expect(scoreCategory("BUG", "cannot login after password reset")).toBe(0));
test("duas pistas de BUG", () => expect(scoreCategory("BUG", "error: bug found")).toBe(2));
test("texto vazio → 0", () => expect(scoreCategory("INCIDENT", "")).toBe(0));
