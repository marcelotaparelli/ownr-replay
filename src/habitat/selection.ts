import type {
  CheckStatus,
  Constraint,
  ConstraintResult,
  Decision,
  DesiredStatus,
  EvaluationResult,
  Fitness,
  GuardResult,
  Measurement,
  MetricComparison,
  Mission,
  Operator,
  Envelope,
} from "./domain.ts";

/**
 * Selection: the pure rules that decide what survives. No I/O, no clock, no model —
 * the same evidence always yields the same decision.
 */

export function satisfies(value: number, operator: Operator, target: number): boolean {
  if (operator === "<=") return value <= target;
  if (operator === ">=") return value >= target;
  return value === target;
}

export function measurementsOf(evaluations: EvaluationResult[]): Map<string, Measurement> {
  const map = new Map<string, Measurement>();
  for (const evaluation of evaluations) for (const m of evaluation.measurements) map.set(m.metric, m);
  return map;
}

export function checkEnvelope(envelope: Envelope, evaluations: EvaluationResult[]): ConstraintResult[] {
  const byEvaluator = new Map(evaluations.map((e) => [e.evaluatorId, e]));
  const measurements = measurementsOf(evaluations);
  return envelope.constraints.map((c) => checkConstraint(c, byEvaluator.get(c.evaluatorId), measurements));
}

function checkConstraint(constraint: Constraint, evaluation: EvaluationResult | undefined, measurements: Map<string, Measurement>): ConstraintResult {
  const base = { constraintId: constraint.id, name: constraint.name, severity: constraint.severity };
  if (!evaluation || evaluation.status === "NOT_RUN") {
    return { ...base, status: "NOT_RUN", detail: evaluation?.errors[0] ?? `avaliador ${constraint.evaluatorId} não executou` };
  }
  if (constraint.metric && constraint.operator && constraint.threshold !== undefined) {
    const m = measurements.get(constraint.metric);
    if (!m || m.value === null) return { ...base, status: "NOT_RUN", detail: `sem medida para ${constraint.metric}` };
    const ok = satisfies(m.value, constraint.operator, constraint.threshold);
    return { ...base, status: ok ? "PASS" : "FAIL", detail: `${constraint.metric} = ${m.value} (esperado ${constraint.operator} ${constraint.threshold})` };
  }
  return { ...base, status: evaluation.status, detail: evaluation.status === "PASS" ? "passou" : (evaluation.errors[0] ?? "falhou") };
}

export function checkGuards(fitness: Fitness, measurements: Map<string, Measurement>): GuardResult[] {
  return fitness.guards.map((g) => {
    const m = measurements.get(g.metric);
    const value = m?.value ?? null;
    const status: CheckStatus = value === null ? "NOT_RUN" : satisfies(value, g.operator, g.threshold) ? "PASS" : "FAIL";
    return { ...g, value, status };
  });
}

export function compareObjectives(fitness: Fitness, baseline: Map<string, Measurement>, candidate: Map<string, Measurement>): MetricComparison[] {
  return fitness.objectives.map((o) => {
    const before = baseline.get(o.metric)?.value ?? null;
    const after = candidate.get(o.metric)?.value ?? null;
    if (before === null || after === null) return { ...o, baseline: before, candidate: after, outcome: "unknown" };
    const better = o.direction === "minimize" ? after < before : after > before;
    const worse = o.direction === "minimize" ? after > before : after < before;
    return { ...o, baseline: before, candidate: after, outcome: better ? "improved" : worse ? "worse" : "unchanged" };
  });
}

/**
 * Envelope first: a HARD failure (or a HARD check that did not run) makes a candidate
 * ineligible whatever its fitness. Then counter-metrics, then objectives against the baseline.
 * PROMOTABLE additionally requires every soft constraint to pass and no objective to be unknown.
 */
export function decide(mission: Pick<Mission, "envelope" | "fitness">, baseline: EvaluationResult[], candidate: EvaluationResult[]): Decision {
  const constraints = checkEnvelope(mission.envelope, candidate);
  const candidateMeasurements = measurementsOf(candidate);
  const guards = checkGuards(mission.fitness, candidateMeasurements);
  const comparisons = compareObjectives(mission.fitness, measurementsOf(baseline), candidateMeasurements);
  const reasons: string[] = [];

  const hardBlocked = constraints.filter((c) => c.severity === "hard" && c.status !== "PASS");
  if (hardBlocked.length > 0) {
    for (const c of hardBlocked) reasons.push(`HARD ${c.name}: ${c.status} — ${c.detail}`);
    return { verdict: "INELIGIBLE", constraints, comparisons, guards, reasons };
  }

  const brokenGuards = guards.filter((g) => g.status !== "PASS");
  for (const g of brokenGuards) reasons.push(`contra-métrica ${g.label}: ${g.value ?? "sem medida"} (exigido ${g.operator} ${g.threshold}) — ${g.reason}`);
  for (const c of comparisons) reasons.push(`${c.label}: ${c.baseline ?? "?"} → ${c.candidate ?? "?"} (${c.outcome})`);

  if (brokenGuards.length > 0) return { verdict: "WORSE", constraints, comparisons, guards, reasons };
  if (comparisons.some((c) => c.outcome === "worse")) return { verdict: "WORSE", constraints, comparisons, guards, reasons };
  if (!comparisons.some((c) => c.outcome === "improved")) return { verdict: "NEUTRAL", constraints, comparisons, guards, reasons };

  const softIssues = constraints.filter((c) => c.severity === "soft" && c.status !== "PASS");
  const unknown = comparisons.filter((c) => c.outcome === "unknown");
  for (const c of softIssues) reasons.push(`SOFT ${c.name}: ${c.status} — ${c.detail}`);
  if (softIssues.length > 0 || unknown.length > 0) return { verdict: "BETTER", constraints, comparisons, guards, reasons };
  return { verdict: "PROMOTABLE", constraints, comparisons, guards, reasons };
}

/** Where the organism stands against the mission. Never MET without enough data. */
export function missionProgress(mission: Pick<Mission, "desiredState">, measurements: Map<string, Measurement>): DesiredStatus[] {
  return mission.desiredState.map((d) => {
    const m = measurements.get(d.metric);
    const sampleSize = m?.sampleSize;
    const enough = d.minSampleSize === undefined || (sampleSize ?? 0) >= d.minSampleSize;
    if (!m || m.value === null || m.status === "INSUFFICIENT_DATA" || !enough) {
      return { ...d, value: m?.value ?? null, ...(sampleSize === undefined ? {} : { sampleSize }), status: "INSUFFICIENT_DATA" };
    }
    return { ...d, value: m.value, ...(sampleSize === undefined ? {} : { sampleSize }), status: satisfies(m.value, d.operator, d.target) ? "MET" : "NOT_MET" };
  });
}

export const missionReached = (progress: DesiredStatus[]): boolean => progress.length > 0 && progress.every((p) => p.status === "MET");
