import { Category, SuggestedTeam } from "./triage.ts";

// TODO: um Record<Category, SuggestedTeam> com uma entrada por categoria:
// INCIDENT → INFRASTRUCTURE, BUG → DEVELOPMENT, ACCESS e SUPPORT → SUPPORT,
// OTHER → HUMAN_REVIEW.

export function suggestedTeamForCategory(category: Category): SuggestedTeam {
  // TODO
  return SuggestedTeam.HUMAN_REVIEW;
}
