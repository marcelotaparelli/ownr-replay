function classify(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("down")) {
    return "INCIDENT";
  }
  return "OTHER";
}
