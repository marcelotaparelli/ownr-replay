function classify(ticket: { title: string; description: string }): string {
  const lower = (ticket.title + " " + ticket.description).toLowerCase();
  if (lower.includes("down")) {
    return "INCIDENT";
  }
  return "OTHER";
}
