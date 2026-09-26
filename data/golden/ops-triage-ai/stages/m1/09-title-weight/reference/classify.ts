const CATEGORIES = ["INCIDENT", "BUG", "ACCESS"];

function classify(ticket: { title: string; description: string }): string {
  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();
  let best = "OTHER";
  let bestScore = 0;
  for (const category of CATEGORIES) {
    const score = scoreCategory(category, title, description);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}
