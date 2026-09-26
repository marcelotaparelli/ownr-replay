import { test, expect } from "ownr:test";
import { Category, classify, RULES } from "./classify.ts";

test("cada regra usa um membro de Category", () => {
  expect(RULES.map((r) => r.category)).toEqual([Category.INCIDENT, Category.INCIDENT, Category.BUG, Category.BUG, Category.ACCESS, Category.ACCESS]);
});
test("comportamento preservado", () => expect(classify({ title: "", description: "login fails with a bug error" })).toBe(Category.ACCESS));
