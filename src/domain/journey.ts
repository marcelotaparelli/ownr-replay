import type { Concept, Stage } from "./stage.ts";

export type GenerationStatus =
  | "queued"
  | "cloning"
  | "analyzing"
  | "mapping_architecture"
  | "planning"
  | "generating_stages"
  | "validating"
  | "ready"
  | "failed";

/** The exact repository state a journey was derived from (cache key: owner/repo@sha). */
export type RepositorySnapshot = {
  owner: string;
  name: string;
  url: string;
  sha: string;
};

export type Journey = {
  id: string;
  title: string;
  description: string;
  repo: RepositorySnapshot;
  status: GenerationStatus;
  concepts: Concept[];
  stages: Stage[];
};

export type StageOutline = Pick<
  Stage,
  "id" | "order" | "title" | "subtitle" | "estimatedMinutes" | "introduces" | "prerequisites" | "summary"
>;

export type JourneyOutline = Omit<Journey, "stages"> & { stages: StageOutline[] };

export function outline(journey: Journey): JourneyOutline {
  return {
    ...journey,
    stages: journey.stages.map((stage) => ({
      id: stage.id,
      order: stage.order,
      title: stage.title,
      ...(stage.subtitle === undefined ? {} : { subtitle: stage.subtitle }),
      estimatedMinutes: stage.estimatedMinutes,
      introduces: stage.introduces,
      prerequisites: stage.prerequisites,
      summary: stage.summary,
    })),
  };
}

export const snapshotKey = (repo: RepositorySnapshot): string => `${repo.owner}/${repo.name}@${repo.sha}`;
