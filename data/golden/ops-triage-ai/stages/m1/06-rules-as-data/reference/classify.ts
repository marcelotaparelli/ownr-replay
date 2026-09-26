const RULES = [
  { word: "down", category: "INCIDENT" },
  { word: "bug", category: "BUG" },
  { word: "login", category: "ACCESS" },
];

function classify(ticket: { title: string; description: string }): string {
  const text = (ticket.title + " " + ticket.description).toLowerCase();
  for (const rule of RULES) {
    if (text.includes(rule.word)) return rule.category;
  }
  return "OTHER";
}
