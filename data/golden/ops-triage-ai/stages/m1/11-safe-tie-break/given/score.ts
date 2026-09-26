import { RULES } from "./rules.ts";

export function scoreCategory(category: string, title: string, description: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && title.includes(rule.word)) score += rule.weight * 2;
    if (rule.category === category && description.includes(rule.word)) score += rule.weight;
  }
  return score;
}
