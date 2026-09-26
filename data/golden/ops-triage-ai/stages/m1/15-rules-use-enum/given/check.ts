import { Category, RULES } from "./classify.ts";

// Cada regra aponta para um membro de Category, não para uma string solta.
export const first: Category = RULES[0].category;

// @ts-expect-error
export const typo: Category = "INCIDNET";
