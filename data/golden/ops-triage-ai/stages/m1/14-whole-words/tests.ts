import { test, expect } from "ownr:test";
import { classify, scoreCategory } from "./classify.ts";

test('"debug" não conta como "bug"', () => expect(scoreCategory("BUG", "debug mode is slow", "")).toBe(0));
test('"downloads" não conta como "down"', () => expect(scoreCategory("INCIDENT", "", "downloads are slow")).toBe(0));
test("bug no título: 3 × 2", () => expect(scoreCategory("BUG", "bug in checkout", "")).toBe(6));
test("login e password na descrição: 4 + 2", () => expect(scoreCategory("ACCESS", "", "login after password reset")).toBe(6));
test("classify: debug mode → OTHER", () => expect(classify({ title: "Debug mode is slow", description: "" })).toBe("OTHER"));
