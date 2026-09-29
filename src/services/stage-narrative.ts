/** A small, consistent sequence for generated lessons. The code stays in referenceCode. */
export type StageNarrative = {
  context: string;
  problem: string;
  quick: string;
  normal: string;
};

export function stageNarrative(input: {
  previous: string;
  need: string;
  limitation: string;
  task: string;
  outcome: string;
  code: string;
  detail: string;
}): StageNarrative {
  return {
    context: `${input.previous} ${input.need}`,
    problem: `${input.limitation} Nesta etapa, ${input.task} Assim, ${input.outcome}`,
    quick: input.code,
    normal: input.detail,
  };
}
