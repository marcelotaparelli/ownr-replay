import { test, expect } from "replay:test";
import { Category, classify, scoreCategory } from "./classifier.ts";

const t = (title: string, description = "") => classify({ title, description });

test("Category tem as quatro categorias", () => {
  expect([Category.INCIDENT, Category.BUG, Category.ACCESS, Category.OTHER]).toEqual(["INCIDENT", "BUG", "ACCESS", "OTHER"]);
});
test("pesos e título em dobro", () => {
  expect(scoreCategory(Category.INCIDENT, "down", "outage")).toBe(14);
  expect(scoreCategory(Category.BUG, "error", "bug")).toBe(5);
  expect(scoreCategory(Category.ACCESS, "", "login after password reset")).toBe(6);
});
test("só palavras inteiras", () => {
  expect(scoreCategory(Category.BUG, "debug mode", "")).toBe(0);
  expect(t("Downloads are slow")).toBe(Category.OTHER);
});
test("maiúsculas não importam", () => expect(t("Production DOWN")).toBe(Category.INCIDENT));
test("mais evidência vence", () => expect(t("Cannot login", "after password reset the page shows a bug")).toBe(Category.ACCESS));
test("empate: INCIDENT > ACCESS > BUG", () => {
  expect(t("", "login fails with a bug error")).toBe(Category.ACCESS);
  expect(t("", "outage login")).toBe(Category.INCIDENT);
});
test("sem pistas → OTHER", () => expect(t("Lunch", "menu")).toBe(Category.OTHER));
