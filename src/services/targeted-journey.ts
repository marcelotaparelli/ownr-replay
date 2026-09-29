import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../domain/journey.ts";
import { Stage } from "../domain/stage.ts";
import { validateJourney } from "./curriculum.ts";

export function targetedJourney(base: Journey, moduleId: string, target: string): Journey {
  const module = base.modules.find((item) => item.id === moduleId);
  const source = base.stages.filter((stage) => stage.moduleId === moduleId);
  if (!module || source.length < 2 || source.at(-1)?.kind !== "checkpoint") throw new Error("O módulo ainda não tem um percurso validado.");
  const normalized = target.trim().toLowerCase();
  const slug = normalized.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "parte";
  const id = `${base.id}--${slug}-${createHash("sha256").update(normalized).digest("hex").slice(0, 8)}`;
  const ids = source.map((stage) => `${id}.${stage.id.split(".").at(-1)}`);
  const stages = source.map((stage, index) => ({ ...stage, id: ids[index]!, order: index + 1,
    tutorContext: { ...stage.tutorContext, previousStages: ids.slice(0, index) } }));
  const journey: Journey = { ...base, id, title: `${base.repo.name}: ${target.trim()}`,
    description: `Percurso para compreender ${target.trim()} no código de ${base.repo.owner}/${base.repo.name}.`,
    goal: { kind: "specific_part", target: target.trim() },
    modules: [{ ...module, stageIds: ids }], stages };
  const problems = validateJourney(journey);
  if (problems.length) throw new Error("Percurso específico inválido: " + problems.join(" | "));
  return journey;
}

export class TargetedJourneyStore {
  constructor(private readonly root: string) {}

  private directory(baseId: string): string { return join(this.root, "targets", baseId); }

  save(base: Journey, moduleId: string, target: string): Journey {
    const journey = targetedJourney(base, moduleId, target);
    const dir = this.directory(base.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${journey.id}.json`);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ moduleId, target: target.trim(), sha: base.repo.sha }, null, 2));
    renameSync(temp, path);
    return journey;
  }

  saveRoute(base: Journey, route: Journey): Journey {
    const dir = this.directory(base.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${route.id}.json`);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ kind: "route", sha: base.repo.sha, journey: route }, null, 2));
    renameSync(temp, path);
    return route;
  }

  restore(bases: Journey[]): Journey[] {
    const restored: Journey[] = [];
    for (const base of bases) {
      const dir = this.directory(base.id);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
        const saved = JSON.parse(readFileSync(join(dir, name), "utf8")) as { kind?: string; moduleId?: string; target?: string; sha: string; journey?: Journey };
        if (saved.sha !== base.repo.sha) continue;
        if (saved.kind === "route" && saved.journey) {
          const route = { ...saved.journey, stages: saved.journey.stages.map((stage) => Stage.parse(stage)) };
          if (validateJourney(route).length === 0) restored.push(route);
        } else if (saved.moduleId && saved.target) restored.push(targetedJourney(base, saved.moduleId, saved.target));
      }
    }
    return restored;
  }
}
