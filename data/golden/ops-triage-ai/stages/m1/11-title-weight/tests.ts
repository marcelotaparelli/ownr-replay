import { test, expect } from "replay:test";
import { classify, scoreCategory } from "./classify.ts";

test("pista no título vale 2", () => expect(scoreCategory("BUG", "bug in checkout", "")).toBe(2));
test("pista na descrição vale 1", () => expect(scoreCategory("BUG", "", "bug in checkout")).toBe(1));
test("título e descrição somam", () => expect(scoreCategory("ACCESS", "cannot login", "password reset")).toBe(3));
test("classify usa o novo placar: título vence", () => expect(classify({ title: "Cannot login", description: "maybe a bug" })).toBe("ACCESS"));
