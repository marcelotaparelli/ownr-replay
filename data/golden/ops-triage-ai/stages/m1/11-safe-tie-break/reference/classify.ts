// Em empate vence quem vem primeiro: ignorar um incidente é o erro mais caro.
const TIE_BREAK = ["INCIDENT", "ACCESS", "BUG"];

function classify(ticket: { title: string; description: string }): string {
  const title = ticket.title.toLowerCase();
  const description = ticket.description.toLowerCase();
  let best = "OTHER";
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
