import { test, expect } from "ownr:test";
import { Category } from "./classify.ts";

test("quatro categorias, cada uma valendo o próprio nome", () => {
  expect([Category.INCIDENT, Category.BUG, Category.ACCESS, Category.OTHER]).toEqual(["INCIDENT", "BUG", "ACCESS", "OTHER"]);
});
