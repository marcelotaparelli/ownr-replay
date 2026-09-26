const RULES = [
  { word: "down", category: "INCIDENT" },
  { word: "outage", category: "INCIDENT" },
  { word: "bug", category: "BUG" },
  { word: "error", category: "BUG" },
  { word: "login", category: "ACCESS" },
  { word: "password", category: "ACCESS" },
];

function classify(ticket: { title: string; description: string }): string {
  const lower = (ticket.title + " " + ticket.description).toLowerCase();
  for (const rule of RULES) {
    if (lower.includes(rule.word)) {
      return rule.category;
    }
  }
  return "OTHER";
}
