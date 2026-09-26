function classify(ticket: { title: string; description: string }): string {
  const text = (ticket.title + " " + ticket.description).toLowerCase();
  if (text.includes("down")) return "INCIDENT";
  if (text.includes("bug")) return "BUG";
  if (text.includes("login")) return "ACCESS";
  return "OTHER";
}
