function scoreCategory(category: string, title: string, description: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && rule.pattern.test(title)) score += rule.weight * 2;
    if (rule.category === category && rule.pattern.test(description)) score += rule.weight;
  }
  return score;
}
