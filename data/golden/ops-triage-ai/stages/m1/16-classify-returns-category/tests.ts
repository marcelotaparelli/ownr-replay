import { test, expect } from "replay:test";
import { Category, classify } from "./classify.ts";

test("classify devolve membros de Category", () => {
  expect(classify({ title: "Cannot login", description: "" })).toBe(Category.ACCESS);
  expect(classify({ title: "Lunch", description: "" })).toBe(Category.OTHER);
});
