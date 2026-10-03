import type { ChainSignals } from "./ast-confidence.ts";

/**
 * EXPERIMENT (not product, nothing imports it): may the AST spike's chain be shown, or should the answer be "no reliable
 * journey"? It never picks a different chain and never touches the ranking: it only accepts or refuses the one chain.
 *
 * The rule was written from reading the signal table of 25 exploratory cases (post hoc): it is a hypothesis to test on a
 * NEW holdout, not a finding. Two signals, both about whether the ranking had a real basis:
 *  - the winner has no close competitor: no other distinct chain scores within 10% of it (a tie or near-tie means the
 *    name-only ranking was indifferent and picked one arbitrarily);
 *  - every node of the chain carries at least one concept of the goal (a chain that wanders through generic helpers does not).
 */

export type Decision = { verdict: "ACCEPT" | "ABSTAIN"; reasons: string[] };

/** Runner-up within 10% of the winner counts as a close competitor (same band the signals use for `nearTop`). */
export const CLOSE_COMPETITOR = 0.9;

export function decide(signals: ChainSignals | null): Decision {
  if (!signals) return { verdict: "ABSTAIN", reasons: ["no chain"] };
  const reasons: string[] = [];
  if (signals.runnerUpRatio >= CLOSE_COMPETITOR) reasons.push(`a competing chain scores ${Math.round(signals.runnerUpRatio * 100)}% of the winner`);
  if (signals.nodesRelatedShare < 1) reasons.push(`${Math.round((1 - signals.nodesRelatedShare) * 100)}% of the chain's nodes carry no concept of the goal`);
  return reasons.length ? { verdict: "ABSTAIN", reasons } : { verdict: "ACCEPT", reasons: [] };
}
