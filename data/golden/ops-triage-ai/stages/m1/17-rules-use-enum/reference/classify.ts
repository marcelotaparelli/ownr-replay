enum Category {
  INCIDENT = "INCIDENT",
  BUG = "BUG",
  ACCESS = "ACCESS",
  OTHER = "OTHER",
}

const RULES = [
  { pattern: /\bdown\b/, category: Category.INCIDENT, weight: 5 },
  { pattern: /\boutage\b/, category: Category.INCIDENT, weight: 4 },
  { pattern: /\bbug\b/, category: Category.BUG, weight: 3 },
  { pattern: /\berror\b/, category: Category.BUG, weight: 1 },
  { pattern: /\blogin\b/, category: Category.ACCESS, weight: 4 },
  { pattern: /\bpassword\b/, category: Category.ACCESS, weight: 2 },
];

function scoreCategory(category: string, title: string, description: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && rule.pattern.test(title)) {
      score += rule.weight * 2;
    }
    if (rule.category === category && rule.pattern.test(description)) {
      score += rule.weight;
    }
  }
  return score;
}

// Em empate vence quem vem primeiro: ignorar um incidente é o erro mais caro.
const TIE_BREAK = [Category.INCIDENT, Category.ACCESS, Category.BUG];

function classify(ticket: { title: string; description: string }): Category {
  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();
  let best = Category.OTHER;
  for (const category of TIE_BREAK) {
    if (scoreCategory(category, title, description) > scoreCategory(best, title, description)) {
      best = category;
    }
  }
  return best;
}
