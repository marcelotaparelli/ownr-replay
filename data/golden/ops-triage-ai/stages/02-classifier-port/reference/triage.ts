export enum Category {
  INCIDENT = "INCIDENT",
  BUG = "BUG",
  ACCESS = "ACCESS",
  SUPPORT = "SUPPORT",
  OTHER = "OTHER",
}

export interface TicketInput {
  title: string;
  description: string;
}

interface Signal {
  pattern: RegExp;
  weight: number;
}

// Cada categoria tem sinais com peso. Mais peso = evidência mais forte.
const SIGNALS: Record<Category, Signal[]> = {
  [Category.INCIDENT]: [
    { pattern: /\bproduction (is )?down\b/, weight: 6 },
    { pattern: /\b(service|system|site) (is )?down\b/, weight: 5 },
    { pattern: /\boutage\b/, weight: 4 },
    { pattern: /\bunavailable\b/, weight: 2 },
  ],
  [Category.BUG]: [
    { pattern: /\bregression\b/, weight: 4 },
    { pattern: /\bbug\b/, weight: 3 },
    { pattern: /\b(exception|broken|fails?)\b/, weight: 2 },
    { pattern: /\berror\b/, weight: 1 },
  ],
  [Category.ACCESS]: [
    { pattern: /\b(cannot|can't|unable to) log ?in\b/, weight: 5 },
    { pattern: /\baccess denied\b/, weight: 5 },
    { pattern: /\b(permission|unauthorized|forbidden)\b/, weight: 4 },
    { pattern: /\b(password|log ?in)\b/, weight: 2 },
  ],
  [Category.SUPPORT]: [
    { pattern: /\bhow (do|can|to)\b/, weight: 4 },
    { pattern: /\bneed help\b/, weight: 4 },
    { pattern: /\bhelp\b/, weight: 2 },
  ],
  [Category.OTHER]: [],
};

// Em empate vence quem aparece primeiro: incidentes antes de tudo.
const TIE_BREAK: Category[] = [
  Category.INCIDENT,
  Category.ACCESS,
  Category.BUG,
  Category.SUPPORT,
  Category.OTHER,
];

export function classify(input: TicketInput): Category {
  const title = normalize(input.title);
  const description = normalize(input.description);

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

export function scoreCategory(category: Category, title: string, description: string): number {
  let score = 0;
  for (const signal of SIGNALS[category]) {
    if (signal.pattern.test(title)) score += signal.weight * 2;
    if (signal.pattern.test(description)) score += signal.weight;
  }
  return score;
}

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
