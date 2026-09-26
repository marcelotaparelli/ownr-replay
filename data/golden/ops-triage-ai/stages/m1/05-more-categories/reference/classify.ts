function classify(ticket: { title: string; description: string }): string {
  const lower = (ticket.title + " " + ticket.description).toLowerCase();
  if (lower.includes("down")) {
    return "INCIDENT";
  }
  if (lower.includes("bug")) {
    return "BUG";
  }
  if (lower.includes("login")) {
    return "ACCESS";
  }
  return "OTHER";
}
