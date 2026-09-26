import { Category } from "./classify.ts";

// Os quatro membros existem e têm o tipo Category.
export const all: Category[] = [Category.INCIDENT, Category.BUG, Category.ACCESS, Category.OTHER];

// Uma string solta, com erro de digitação, NÃO pode ser uma Category.
// @ts-expect-error
export const typo: Category = "INCIDNET";
