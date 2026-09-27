const RULES = [
  { word: "down", category: "INCIDENT" },
  { word: "outage", category: "INCIDENT" },
  { word: "bug", category: "BUG" },
  { word: "error", category: "BUG" },
  { word: "login", category: "ACCESS" },
  { word: "password", category: "ACCESS" },
];

function scoreCategory(category: string, title: string, description: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && title.includes(rule.word)) {
      score += 2;
    }
    if (rule.category === category && description.includes(rule.word)) {
      score += 1;
    }
  }
  return score;
}

function classify(ticket: { title: string; description: string }): string {
  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();
  let best = "OTHER";
  for (const category of ["INCIDENT", "BUG", "ACCESS"]) {
    if (scoreCategory(category, title, description) > scoreCategory(best, title, description)) {
      best = category;
    }
  }
  return best;
}
