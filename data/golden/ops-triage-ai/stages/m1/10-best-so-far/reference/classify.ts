const RULES = [
  { word: "down", category: "INCIDENT" },
  { word: "outage", category: "INCIDENT" },
  { word: "bug", category: "BUG" },
  { word: "error", category: "BUG" },
  { word: "login", category: "ACCESS" },
  { word: "password", category: "ACCESS" },
];

function scoreCategory(category: string, text: string): number {
  let score = 0;
  for (const rule of RULES) {
    if (rule.category === category && text.includes(rule.word)) {
      score += 1;
    }
  }
  return score;
}

function classify(ticket: { title: string; description: string }): string {
  const lower = (ticket.title + " " + ticket.description).toLowerCase();
  let best = "OTHER";
  for (const category of ["INCIDENT", "BUG", "ACCESS"]) {
    if (scoreCategory(category, lower) > scoreCategory(best, lower)) {
      best = category;
    }
  }
  return best;
}
