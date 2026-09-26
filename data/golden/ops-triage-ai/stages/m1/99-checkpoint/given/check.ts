import { Category, classify, scoreCategory } from "./classifier.ts";

// classify devolve uma Category; scoreCategory, um número.
export const decided: Category = classify({ title: "Server down", description: "" });
export const points: number = scoreCategory(Category.BUG, "bug", "");

// Uma string solta não é uma Category.
// @ts-expect-error
export const typo: Category = "INCIDNET";
