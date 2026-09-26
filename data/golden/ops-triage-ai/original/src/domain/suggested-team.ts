import { Category, SuggestedTeam } from "./triage.ts";

const SUGGESTED_TEAM_BY_CATEGORY: Readonly<Record<Category, SuggestedTeam>> = {
  [Category.INCIDENT]: SuggestedTeam.INFRASTRUCTURE,
  [Category.BUG]: SuggestedTeam.DEVELOPMENT,
  [Category.FEATURE_REQUEST]: SuggestedTeam.PRODUCT,
  [Category.CONTENT_CHANGE]: SuggestedTeam.CONTENT,
  [Category.SUPPORT]: SuggestedTeam.SUPPORT,
  [Category.ACCESS]: SuggestedTeam.SUPPORT,
  [Category.OTHER]: SuggestedTeam.HUMAN_REVIEW,
};

export function suggestedTeamForCategory(category: Category): SuggestedTeam {
  return SUGGESTED_TEAM_BY_CATEGORY[category];
}
