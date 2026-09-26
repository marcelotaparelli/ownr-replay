function classify(ticket: { title: string; description: string }): string {
  const text = (ticket.title + " " + ticket.description).toLowerCase();
  if (text.includes("down")) return "INCIDENT";
  return "OTHER";
}
