import { test, expect } from "replay:test";
import { Category } from "./category.ts";
import { classify } from "./classify.ts";

test("quatro categorias, cada uma valendo o próprio nome", () => {
  expect(Category.INCIDENT).toBe("INCIDENT");
  expect(Category.BUG).toBe("BUG");
  expect(Category.ACCESS).toBe("ACCESS");
  expect(Category.OTHER).toBe("OTHER");
});
test("classify devolve membros de Category", () => {
  expect(classify({ title: "Cannot login", description: "" })).toBe(Category.ACCESS);
  expect(classify({ title: "Lunch", description: "" })).toBe(Category.OTHER);
});
