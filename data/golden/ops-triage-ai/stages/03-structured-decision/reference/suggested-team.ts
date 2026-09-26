import { Category, SuggestedTeam } from "./triage.ts";

// Record exige uma entrada por categoria: esquecer uma não compila.
const TEAM_BY_CATEGORY: Readonly<Record<Category, SuggestedTeam>> = {
  [Category.INCIDENT]: SuggestedTeam.INFRASTRUCTURE,
  [Category.BUG]: SuggestedTeam.DEVELOPMENT,
  [Category.ACCESS]: SuggestedTeam.SUPPORT,
  [Category.SUPPORT]: SuggestedTeam.SUPPORT,
  [Category.OTHER]: SuggestedTeam.HUMAN_REVIEW,
};

export function suggestedTeamForCategory(category: Category): SuggestedTeam {
  return TEAM_BY_CATEGORY[category];
}
