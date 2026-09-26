const TIE_BREAK = [Category.INCIDENT, Category.ACCESS, Category.BUG];

function classify(ticket: { title: string; description: string }): Category {
  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();
  let best = Category.OTHER;
  let bestScore = 0;
  for (const category of TIE_BREAK) {
    const score = scoreCategory(category, title, description);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}
