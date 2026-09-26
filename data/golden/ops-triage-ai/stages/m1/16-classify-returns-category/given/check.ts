import { Category, classify } from "./classify.ts";

// classify devolve uma Category.
export const decided: Category = classify({ title: "Server down", description: "" });
