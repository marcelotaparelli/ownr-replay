import { Database } from "bun:sqlite";
import { z } from "zod";
import { Mission, type Candidate, type CandidateSource, type CandidateStatus, type Decision, type EvaluationResult, type FileChange } from "./domain.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id          TEXT PRIMARY KEY,
  organism_id TEXT NOT NULL,
  -- Snapshot taken when the mission starts: envelope and fitness cannot drift mid-mission.
  definition  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id         TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  revision   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS candidates (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  proposal_id     TEXT NOT NULL,
  generation      INTEGER NOT NULL CHECK (generation >= 1),
  parent_revision TEXT NOT NULL,
  revision        TEXT,
  hypothesis      TEXT NOT NULL,
  source          TEXT NOT NULL,
  claims          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('proposed','prepared','evaluating','ineligible','eligible','promotable','promoted','rejected')),
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_changes (
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  path         TEXT NOT NULL,
  status       TEXT NOT NULL,
  old_mode     TEXT NOT NULL,
  new_mode     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('observation','candidate')),
  subject_id   TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('PASS','FAIL','NOT_RUN')),
  result       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evaluations_by_subject ON evaluations (subject_kind, subject_id);
CREATE TABLE IF NOT EXISTS decisions (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),
  verdict      TEXT NOT NULL,
  detail       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
-- The flight recorder: append-only, one row per thing that happened.
CREATE TABLE IF NOT EXISTS habitat_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  mission_id   TEXT,
  candidate_id TEXT,
  data         TEXT,
  created_at   INTEGER NOT NULL
);
`;

const MeasurementRow = z.object({
  metric: z.string(),
  value: z.number().nullable(),
  status: z.enum(["MEASURED", "INSUFFICIENT_DATA"]),
  unit: z.string().optional(),
  sampleSize: z.number().optional(),
  window: z.string().optional(),
  note: z.string().optional(),
});
const EvaluationRow = z.object({
  evaluatorId: z.string(),
  status: z.enum(["PASS", "FAIL", "NOT_RUN"]),
  measurements: z.array(MeasurementRow),
  evidence: z.array(z.object({ kind: z.enum(["command", "files", "report", "note"]), summary: z.string(), detail: z.string().optional() })),
  durationMs: z.number(),
  errors: z.array(z.string()),
});

export type HabitatEvent = { id: number; kind: string; missionId: string | null; candidateId: string | null; data: Record<string, unknown> | null; createdAt: number };
export type Observation = { id: string; missionId: string; revision: string; createdAt: number };

type CandidateRow = {
  id: string;
  mission_id: string;
  proposal_id: string;
  generation: number;
  parent_revision: string;
  revision: string | null;
  hypothesis: string;
  source: string;
  claims: string | null;
  status: CandidateStatus;
  created_at: number;
};

export class HabitatStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Stores the mission once; later calls return the stored snapshot, never the new definition. */
  ensureMission(mission: Mission): Mission {
    const existing = this.mission(mission.id);
    if (existing) return existing;
    this.db.query("INSERT INTO missions (id, organism_id, definition, created_at) VALUES ($id, $organism, $definition, $now)").run({
      id: mission.id,
      organism: mission.organismId,
      definition: JSON.stringify(mission),
      now: Date.now(),
    });
    this.record("mission_started", { missionId: mission.id, data: { objective: mission.objective } });
    return mission;
  }

  mission(id: string): Mission | undefined {
    const row = this.db.query<{ definition: string }, { id: string }>("SELECT definition FROM missions WHERE id = $id").get({ id });
    return row ? Mission.parse(JSON.parse(row.definition)) : undefined;
  }

  addObservation(missionId: string, revision: string): Observation {
    const observation = { id: `obs-${crypto.randomUUID().slice(0, 8)}`, missionId, revision, createdAt: Date.now() };
    this.db.query("INSERT INTO observations (id, mission_id, revision, created_at) VALUES ($id, $missionId, $revision, $createdAt)").run(observation);
    return observation;
  }

  latestObservation(missionId: string): Observation | undefined {
    return this.db
      .query<{ id: string; mission_id: string; revision: string; created_at: number }, { missionId: string }>(
        "SELECT * FROM observations WHERE mission_id = $missionId ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .all({ missionId })
      .map((r) => ({ id: r.id, missionId: r.mission_id, revision: r.revision, createdAt: r.created_at }))[0];
  }

  addCandidate(c: Omit<Candidate, "createdAt" | "status" | "revision">): Candidate {
    const candidate: Candidate = { ...c, revision: null, status: "proposed", createdAt: Date.now() };
    this.db
      .query(
        `INSERT INTO candidates (id, mission_id, proposal_id, generation, parent_revision, revision, hypothesis, source, claims, status, created_at)
         VALUES ($id, $missionId, $proposalId, $generation, $parentRevision, NULL, $hypothesis, $source, $claims, 'proposed', $createdAt)`,
      )
      .run({ ...candidate, source: JSON.stringify(candidate.source) });
    return candidate;
  }

  updateCandidate(id: string, patch: { status?: CandidateStatus; revision?: string }): void {
    if (patch.revision !== undefined) this.db.query("UPDATE candidates SET revision = $revision WHERE id = $id").run({ id, revision: patch.revision });
    if (patch.status !== undefined) this.db.query("UPDATE candidates SET status = $status WHERE id = $id").run({ id, status: patch.status });
  }

  candidate(id: string): Candidate | undefined {
    const row = this.db.query<CandidateRow, { id: string }>("SELECT * FROM candidates WHERE id = $id").get({ id });
    return row ? toCandidate(row) : undefined;
  }

  candidates(missionId: string): Candidate[] {
    return this.db.query<CandidateRow, { missionId: string }>("SELECT * FROM candidates WHERE mission_id = $missionId ORDER BY created_at, rowid").all({ missionId }).map(toCandidate);
  }

  addChanges(candidateId: string, changes: FileChange[]): void {
    const insert = this.db.query("INSERT INTO candidate_changes (candidate_id, path, status, old_mode, new_mode) VALUES ($candidateId, $path, $status, $oldMode, $newMode)");
    this.db.transaction(() => changes.forEach((c) => insert.run({ candidateId, ...c })))();
  }

  changes(candidateId: string): FileChange[] {
    return this.db
      .query<{ path: string; status: string; old_mode: string; new_mode: string }, { candidateId: string }>("SELECT * FROM candidate_changes WHERE candidate_id = $candidateId")
      .all({ candidateId })
      .map((r) => ({ path: r.path, status: r.status, oldMode: r.old_mode, newMode: r.new_mode }));
  }

  addEvaluation(subjectKind: "observation" | "candidate", subjectId: string, result: EvaluationResult): void {
    this.db
      .query("INSERT INTO evaluations (subject_kind, subject_id, evaluator_id, status, result, created_at) VALUES ($kind, $subjectId, $evaluatorId, $status, $result, $now)")
      .run({ kind: subjectKind, subjectId, evaluatorId: result.evaluatorId, status: result.status, result: JSON.stringify(result), now: Date.now() });
  }

  evaluations(subjectKind: "observation" | "candidate", subjectId: string): EvaluationResult[] {
    return this.db
      .query<{ result: string }, { kind: string; subjectId: string }>("SELECT result FROM evaluations WHERE subject_kind = $kind AND subject_id = $subjectId ORDER BY id")
      .all({ kind: subjectKind, subjectId })
      .map((r) => EvaluationRow.parse(JSON.parse(r.result)) as EvaluationResult);
  }

  saveDecision(candidateId: string, decision: Decision): void {
    this.db
      .query("INSERT OR REPLACE INTO decisions (candidate_id, verdict, detail, created_at) VALUES ($candidateId, $verdict, $detail, $now)")
      .run({ candidateId, verdict: decision.verdict, detail: JSON.stringify(decision), now: Date.now() });
  }

  decision(candidateId: string): Decision | undefined {
    const row = this.db.query<{ detail: string }, { candidateId: string }>("SELECT detail FROM decisions WHERE candidate_id = $candidateId").get({ candidateId });
    return row ? (JSON.parse(row.detail) as Decision) : undefined;
  }

  record(kind: string, input: { missionId?: string; candidateId?: string; data?: Record<string, unknown> } = {}): void {
    this.db
      .query("INSERT INTO habitat_events (kind, mission_id, candidate_id, data, created_at) VALUES ($kind, $missionId, $candidateId, $data, $now)")
      .run({ kind, missionId: input.missionId ?? null, candidateId: input.candidateId ?? null, data: input.data ? JSON.stringify(input.data) : null, now: Date.now() });
  }

  events(limit = 200): HabitatEvent[] {
    return this.db
      .query<{ id: number; kind: string; mission_id: string | null; candidate_id: string | null; data: string | null; created_at: number }, { limit: number }>(
        "SELECT * FROM habitat_events ORDER BY id DESC LIMIT $limit",
      )
      .all({ limit })
      .map((r) => ({ id: r.id, kind: r.kind, missionId: r.mission_id, candidateId: r.candidate_id, data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null, createdAt: r.created_at }));
  }
}

function toCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    missionId: row.mission_id,
    proposalId: row.proposal_id,
    generation: row.generation,
    parentRevision: row.parent_revision,
    revision: row.revision,
    hypothesis: row.hypothesis,
    source: JSON.parse(row.source) as CandidateSource,
    claims: row.claims,
    status: row.status,
    createdAt: row.created_at,
  };
}
