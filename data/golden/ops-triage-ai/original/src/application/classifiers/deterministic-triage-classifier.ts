import {
  Category,
  type ClassifierResult,
  type HeuristicConfidence,
  Priority,
  Risk,
  type TicketInput,
} from "../../domain/triage.ts";
import { suggestedTeamForCategory } from "../../domain/suggested-team.ts";
import type { TriageClassifier } from "../ports/triage-classifier.ts";

interface CategorySignal {
  pattern: RegExp;
  weight: number;
  label: string;
}

interface CategoryScore {
  category: Category;
  score: number;
  matched: string[];
}

const CATEGORY_SIGNALS: Readonly<Record<Category, readonly CategorySignal[]>> = {
  [Category.INCIDENT]: [
    { pattern: /\bproduction (is )?down\b/, weight: 6, label: "production_down" },
    { pattern: /\b(service|system|site|platform) (is )?down\b/, weight: 5, label: "service_down" },
    { pattern: /\b(outage|widespread)\b/, weight: 4, label: "outage" },
    { pattern: /\bunavailable\b/, weight: 2, label: "unavailable" },
  ],
  [Category.BUG]: [
    { pattern: /\bregression\b/, weight: 4, label: "regression" },
    { pattern: /\bbug\b/, weight: 3, label: "bug" },
    { pattern: /\b(exception|broken|fails?)\b/, weight: 2, label: "failure" },
    { pattern: /\berror\b/, weight: 1, label: "error" },
  ],
  [Category.FEATURE_REQUEST]: [
    { pattern: /\bfeature request\b/, weight: 6, label: "feature_request" },
    { pattern: /\b(new capability|enhancement)\b/, weight: 4, label: "enhancement" },
    { pattern: /\badd support for\b/, weight: 3, label: "add_support" },
    { pattern: /\bwould like\b/, weight: 2, label: "would_like" },
  ],
  [Category.CONTENT_CHANGE]: [
    { pattern: /\b(text|copy) change\b/, weight: 5, label: "text_change" },
    { pattern: /\bcontent update\b/, weight: 4, label: "content_update" },
    { pattern: /\btypo\b/, weight: 4, label: "typo" },
    { pattern: /\b(banner|translation)\b/, weight: 3, label: "content_asset" },
    { pattern: /\b(copy|wording)\b/, weight: 1, label: "copy" },
  ],
  [Category.SUPPORT]: [
    { pattern: /\bhow (do|can|to)\b/, weight: 4, label: "how_to" },
    { pattern: /\bneed help\b/, weight: 4, label: "need_help" },
    { pattern: /\b(question|guidance|assistance)\b/, weight: 3, label: "support_request" },
    { pattern: /\bhelp\b/, weight: 2, label: "help" },
  ],
  [Category.ACCESS]: [
    { pattern: /\b(cannot|can't|unable to) log ?in\b/, weight: 5, label: "cannot_login" },
    { pattern: /\baccess denied\b/, weight: 5, label: "access_denied" },
    { pattern: /\b(permission|unauthorized|forbidden)\b/, weight: 4, label: "permission" },
    { pattern: /\b(401|403|mfa)\b/, weight: 3, label: "auth_signal" },
    { pattern: /\b(password|log ?in)\b/, weight: 2, label: "login" },
    { pattern: /\baccess\b/, weight: 1, label: "access" },
  ],
  [Category.OTHER]: [],
};

// Consulted only for exact score ties. Safety-sensitive operational categories win.
const CATEGORY_TIE_BREAK: readonly Category[] = [
  Category.INCIDENT,
  Category.ACCESS,
  Category.BUG,
  Category.FEATURE_REQUEST,
  Category.CONTENT_CHANGE,
  Category.SUPPORT,
  Category.OTHER,
];

export class DeterministicTriageClassifier implements TriageClassifier {
  async classify(input: TicketInput): Promise<ClassifierResult> {
    const title = normalize(input.title);
    const description = normalize(input.description);
    const scores = CATEGORY_TIE_BREAK.map((category) =>
      scoreCategory(category, title, description),
    );
    const highestScore = Math.max(...scores.map(({ score }) => score));
    const leaders = scores.filter(({ score }) => score === highestScore);
    const winner =
      highestScore === 0 ? scoreCategory(Category.OTHER, title, description) : leaders[0]!;
    const runnerUpScore = Math.max(
      0,
      ...scores
        .filter(({ category }) => category !== winner.category)
        .map(({ score }) => score),
    );
    const confidence = confidenceFor(winner, leaders.length, runnerUpScore);
    const combined = title + " " + description;
    const priority = classifyPriority(winner.category, combined);
    const risk = classifyRisk(winner.category, combined);

    return {
      category: winner.category,
      priority: priority.value,
      risk: risk.value,
      suggestedTeam: suggestedTeamForCategory(winner.category),
      confidence,
      summary: summarize(input.title),
      rationale: [
        categoryRationale(winner, confidence, leaders.length),
        priority.code,
        risk.code,
      ].join(" | "),
    };
  }
}

function scoreCategory(category: Category, title: string, description: string): CategoryScore {
  let score = 0;
  const matched = new Set<string>();

  for (const signal of CATEGORY_SIGNALS[category]) {
    if (signal.pattern.test(title)) {
      score += signal.weight * 2;
      matched.add(signal.label);
    }
    if (signal.pattern.test(description)) {
      score += signal.weight;
      matched.add(signal.label);
    }
  }

  return { category, score, matched: [...matched] };
}

function confidenceFor(
  winner: CategoryScore,
  leaderCount: number,
  runnerUpScore: number,
): HeuristicConfidence {
  if (winner.score === 0 || leaderCount > 1) return 0.5;
  const margin = winner.score - runnerUpScore;
  if (winner.score >= 8 && margin >= 3) return 0.9;
  if (winner.matched.length >= 2 && margin >= 3) return 0.9;
  return 0.7;
}

function categoryRationale(
  winner: CategoryScore,
  confidence: HeuristicConfidence,
  leaderCount: number,
): string {
  if (winner.category === Category.OTHER) return "CATEGORY_DEFAULT";
  if (leaderCount > 1) return "CATEGORY_TIE_BREAK: " + winner.matched.join(" + ");
  const strength = confidence === 0.9 ? "HIGH" : "PARTIAL";
  return winner.category + "_" + strength + "_SIGNAL: " + winner.matched.join(" + ");
}

function classifyPriority(
  category: Category,
  text: string,
): { value: Priority; code: string } {
  const severeDanger =
    /\b(data loss|lost data|data corruption|corrupted data|security breach|data breach|account compromised|compromised credentials)\b/.test(
      text,
    );
  const production = /\b(prod|production)\b/.test(text);
  const outage =
    /\b(outage|unavailable)\b|\b(service|system|site|platform|production) (is )?down\b/.test(
      text,
    );
  const broadImpact = /\b(all users|all customers|everyone|company wide|widespread)\b/.test(text);
  const blocking = /\b(blocked|blocking|cannot work|can't work|unable to work)\b/.test(text);

  if (severeDanger) return { value: Priority.CRITICAL, code: "PRIORITY_CRITICAL_DANGER" };
  if (production && outage && broadImpact) {
    return { value: Priority.CRITICAL, code: "PRIORITY_CRITICAL_BROAD_OUTAGE" };
  }
  if (production && outage) return { value: Priority.HIGH, code: "PRIORITY_HIGH_PRODUCTION" };
  if (category === Category.INCIDENT) {
    return { value: Priority.HIGH, code: "PRIORITY_HIGH_INCIDENT" };
  }
  if (/\bregression\b/.test(text) && blocking) {
    return { value: Priority.HIGH, code: "PRIORITY_HIGH_BLOCKING_REGRESSION" };
  }
  if (
    category === Category.ACCESS &&
    /\b(production|deployment|admin|administrator|on call)\b/.test(text)
  ) {
    return { value: Priority.HIGH, code: "PRIORITY_HIGH_CRITICAL_ACCESS" };
  }
  if (category === Category.BUG || category === Category.ACCESS) {
    return { value: Priority.MEDIUM, code: "PRIORITY_MEDIUM_OPERATIONAL" };
  }
  return { value: Priority.LOW, code: "PRIORITY_LOW_DEFAULT" };
}

function classifyRisk(category: Category, text: string): { value: Risk; code: string } {
  const severeDanger =
    /\b(data loss|lost data|data corruption|corrupted data|security breach|data breach|account compromised|compromised credentials)\b/.test(
      text,
    );
  const productionOutage =
    /\b(prod|production)\b/.test(text) &&
    /\b(outage|unavailable)\b|\b(service|system|site|platform|production) (is )?down\b/.test(
      text,
    );
  const broadImpact = /\b(all users|all customers|everyone|company wide|widespread)\b/.test(text);

  if (severeDanger || (productionOutage && broadImpact)) {
    return { value: Risk.HIGH, code: "RISK_HIGH_DANGER" };
  }
  if (productionOutage) return { value: Risk.HIGH, code: "RISK_HIGH_PRODUCTION_OUTAGE" };
  if (
    category === Category.INCIDENT ||
    /\b(regression|blocked|blocking|admin|administrator|permission)\b/.test(text)
  ) {
    return { value: Risk.MEDIUM, code: "RISK_MEDIUM_OPERATIONAL" };
  }
  return { value: Risk.LOW, code: "RISK_LOW_DEFAULT" };
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(title: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  return trimmed.length <= 160 ? trimmed : trimmed.slice(0, 157) + "...";
}
