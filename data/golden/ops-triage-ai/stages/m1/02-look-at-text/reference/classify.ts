function classify(text: string): string {
  if (text.includes("down")) return "INCIDENT";
  return "OTHER";
}
