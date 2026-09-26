import { test, expect } from "replay:test";
import { Category, classify, scoreCategory } from "./triage.ts";

test("sinal no título vale o dobro", () => {
  expect(scoreCategory(Category.BUG, "bug", "")).toBe(6);
  expect(scoreCategory(Category.BUG, "", "bug")).toBe(3);
});

test("pesos de sinais diferentes se somam", () => {
  expect(scoreCategory(Category.ACCESS, "cannot login", "access denied")).toBe(19);
});

test("produção fora do ar → INCIDENT", () => {
  const ticket = { title: "Production is down", description: "Checkout returns 500 for everyone" };
  expect(classify(ticket)).toBe(Category.INCIDENT);
});

test("não consigo logar → ACCESS", () => {
  const ticket = { title: "Cannot login after password reset", description: "I get access denied" };
  expect(classify(ticket)).toBe(Category.ACCESS);
});

test("sem nenhum sinal → OTHER", () => {
  expect(classify({ title: "Lunch menu", description: "What is for lunch on Friday?" })).toBe(Category.OTHER);
});

test("título pesa mais que descrição", () => {
  const ticket = { title: "Bug in checkout", description: "How do I report it properly?" };
  expect(classify(ticket)).toBe(Category.BUG);
});

test("empate: INCIDENT vence BUG (ordem de TIE_BREAK)", () => {
  const ticket = { title: "Checkout", description: "Payment page unavailable and broken" };
  expect(classify(ticket)).toBe(Category.INCIDENT);
});
