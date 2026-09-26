import { Category, classify } from "./classify.ts";

// classify devolve uma Category.
export const decided: Category = classify({ title: "Server down", description: "" });

// Uma string solta, com erro de digitação, NÃO pode ser uma Category.
// @ts-expect-error
export const typo: Category = "INCIDNET";
