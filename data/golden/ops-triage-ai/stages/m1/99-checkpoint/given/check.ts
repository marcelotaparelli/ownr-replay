import { Category, RULES, classify, scoreCategory } from "./classify.ts";

// classify devolve uma Category; scoreCategory, um número; a tabela usa Category.
export const decided: Category = classify({ title: "Server down", description: "" });
export const points: number = scoreCategory(Category.BUG, "bug", "");
export const first: Category = RULES[0].category;

// Uma string solta não é uma Category.
// @ts-expect-error
export const typo: Category = "INCIDNET";
