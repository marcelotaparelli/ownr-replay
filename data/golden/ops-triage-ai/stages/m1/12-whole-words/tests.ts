import { test, expect } from "replay:test";
import { scoreCategory } from "./score.ts";

test('"debug" não conta como "bug"', () => expect(scoreCategory("BUG", "debug mode is slow", "")).toBe(0));
test('"downloads" não conta como "down"', () => expect(scoreCategory("INCIDENT", "", "downloads are slow")).toBe(0));
test("bug no título: 3 × 2", () => expect(scoreCategory("BUG", "bug in checkout", "")).toBe(6));
test("down no título: 5 × 2", () => expect(scoreCategory("INCIDENT", "server down", "")).toBe(10));
test("login e password na descrição: 4 + 2", () => expect(scoreCategory("ACCESS", "", "login after password reset")).toBe(6));
test("outage (4) e error (1) continuam valendo", () => {
  expect(scoreCategory("INCIDENT", "", "outage")).toBe(4);
  expect(scoreCategory("BUG", "", "error")).toBe(1);
});
