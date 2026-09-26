import { Category } from "./category.ts";

export const RULES = [
  { pattern: /\bdown\b/, category: Category.INCIDENT, weight: 5 },
  { pattern: /\boutage\b/, category: Category.INCIDENT, weight: 4 },
  { pattern: /\bbug\b/, category: Category.BUG, weight: 3 },
  { pattern: /\berror\b/, category: Category.BUG, weight: 1 },
  { pattern: /\blogin\b/, category: Category.ACCESS, weight: 4 },
  { pattern: /\bpassword\b/, category: Category.ACCESS, weight: 2 },
];
