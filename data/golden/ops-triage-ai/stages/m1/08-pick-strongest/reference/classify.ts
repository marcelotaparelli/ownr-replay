const CATEGORIES = ["INCIDENT", "BUG", "ACCESS"];

function classify(ticket: { title: string; description: string }): string {
  const text = (ticket.title + " " + ticket.description).toLowerCase();
  let best = "OTHER";
  let bestScore = 0;
  for (const category of CATEGORIES) {
    const score = scoreCategory(category, text);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}
