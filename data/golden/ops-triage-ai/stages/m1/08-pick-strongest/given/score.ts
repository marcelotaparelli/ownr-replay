import { RULES } from "./rules.ts";

export function scoreCategory(category: string, text: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && text.includes(rule.word)) score += 1;
  }
  return score;
}
