import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeLevel, LearningEventType, StageProgress, StageStatus } from "../domain/progress.ts";
import type { TutorMessage, TutorRole } from "../domain/tutor.ts";

type ProgressRow = {
  learner_id: string;
  stage_id: string;
  status: StageStatus;
  anchor: string | null;
  time_spent_ms: number;
  updated_at: number;
};

export class Repository {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  }

  close(): void {
    this.db.close();
  }

  saveProgress(input: {
    learnerId: string;
    journeyId: string;
    stageId: string;
    status: StageStatus;
    anchor: string | null;
    timeSpentMs: number;
  }): void {
    this.db
      .query(
        `INSERT INTO stage_progress (learner_id, journey_id, stage_id, status, anchor, time_spent_ms, updated_at)
         VALUES ($learnerId, $journeyId, $stageId, $status, $anchor, $timeSpentMs, $now)
         ON CONFLICT (learner_id, stage_id) DO UPDATE SET
           status = excluded.status,
           anchor = COALESCE(excluded.anchor, stage_progress.anchor),
           time_spent_ms = stage_progress.time_spent_ms + excluded.time_spent_ms,
           updated_at = excluded.updated_at`,
      )
      .run({ ...input, now: Date.now() });
  }

  listProgress(learnerId: string, journeyId: string): StageProgress[] {
    return this.db
      .query<ProgressRow, { learnerId: string; journeyId: string }>(
        `SELECT learner_id, stage_id, status, anchor, time_spent_ms, updated_at
         FROM stage_progress WHERE learner_id = $learnerId AND journey_id = $journeyId`,
      )
      .all({ learnerId, journeyId })
      .map((row) => ({
        learnerId: row.learner_id,
        stageId: row.stage_id,
        status: row.status,
        anchor: row.anchor,
        timeSpentMs: row.time_spent_ms,
        updatedAt: row.updated_at,
      }));
  }

  setKnowledge(learnerId: string, conceptIds: string[], state: KnowledgeLevel): void {
    const statement = this.db.query(
      `INSERT INTO knowledge_state (learner_id, concept_id, state, updated_at)
       VALUES ($learnerId, $conceptId, $state, $now)
       ON CONFLICT (learner_id, concept_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const conceptId of conceptIds) statement.run({ learnerId, conceptId, state, now });
    })();
  }

  listKnowledge(learnerId: string): { conceptId: string; state: KnowledgeLevel }[] {
    return this.db
      .query<{ concept_id: string; state: KnowledgeLevel }, { learnerId: string }>(
        "SELECT concept_id, state FROM knowledge_state WHERE learner_id = $learnerId",
      )
      .all({ learnerId })
      .map((row) => ({ conceptId: row.concept_id, state: row.state }));
  }

  /** Returns how many attempts the learner had on this stage before this one. */
  recordAttempt(input: {
    learnerId: string;
    stageId: string;
    runner: string;
    passed: number;
    total: number;
    latencyMs: number;
  }): number {
    const previous = this.db
      .query<{ n: number }, { learnerId: string; stageId: string }>(
        "SELECT COUNT(*) AS n FROM attempts WHERE learner_id = $learnerId AND stage_id = $stageId",
      )
      .get({ learnerId: input.learnerId, stageId: input.stageId });
    this.db
      .query(
        `INSERT INTO attempts (learner_id, stage_id, runner, passed, total, latency_ms, created_at)
         VALUES ($learnerId, $stageId, $runner, $passed, $total, $latencyMs, $now)`,
      )
      .run({ ...input, latencyMs: Math.round(input.latencyMs), now: Date.now() });
    return previous?.n ?? 0;
  }

  appendTutorMessage(threadId: string, learnerId: string, stageId: string, role: TutorRole, content: string): void {
    this.db
      .query(
        `INSERT INTO tutor_messages (thread_id, learner_id, stage_id, role, content, created_at)
         VALUES ($threadId, $learnerId, $stageId, $role, $content, $now)`,
      )
      .run({ threadId, learnerId, stageId, role, content, now: Date.now() });
  }

  /** Only the owner's messages for that stage; a foreign thread id yields nothing. */
  tutorHistory(threadId: string, learnerId: string, stageId: string, limit = 20): TutorMessage[] {
    return this.db
      .query<TutorMessage, { threadId: string; learnerId: string; stageId: string; limit: number }>(
        `SELECT role, content FROM (
           SELECT id, role, content FROM tutor_messages
           WHERE thread_id = $threadId AND learner_id = $learnerId AND stage_id = $stageId
           ORDER BY id DESC LIMIT $limit
         ) ORDER BY id`,
      )
      .all({ threadId, learnerId, stageId, limit });
  }

  recordJourneyRequest(input: {
    learnerId: string | null;
    owner: string;
    name: string;
    goal: { kind: string; target?: string | undefined; topic?: string | undefined; note?: string | undefined };
    served: boolean;
  }): void {
    this.db
      .query(
        `INSERT INTO journey_requests (learner_id, repo_owner, repo_name, goal_kind, goal_target, goal_topic, goal_note, served, created_at)
         VALUES ($learnerId, $owner, $name, $kind, $target, $topic, $note, $served, $now)`,
      )
      .run({
        learnerId: input.learnerId,
        owner: input.owner,
        name: input.name,
        kind: input.goal.kind,
        target: input.goal.target ?? null,
        topic: input.goal.topic ?? null,
        note: input.goal.note ?? null,
        served: input.served ? 1 : 0,
        now: Date.now(),
      });
  }

  countJourneyRequests(goalKind: string): number {
    return (
      this.db
        .query<{ n: number }, { goalKind: string }>("SELECT COUNT(*) AS n FROM journey_requests WHERE goal_kind = $goalKind")
        .get({ goalKind })?.n ?? 0
    );
  }

  appendEvent(input: {
    learnerId: string;
    journeyId: string;
    stageId: string | null;
    type: LearningEventType;
    data?: Record<string, unknown>;
  }): void {
    this.db
      .query(
        `INSERT INTO events (learner_id, journey_id, stage_id, type, data, created_at)
         VALUES ($learnerId, $journeyId, $stageId, $type, $data, $now)`,
      )
      .run({
        learnerId: input.learnerId,
        journeyId: input.journeyId,
        stageId: input.stageId,
        type: input.type,
        data: input.data ? JSON.stringify(input.data) : null,
        now: Date.now(),
      });
  }

  countEvents(learnerId: string, type: LearningEventType): number {
    return (
      this.db
        .query<{ n: number }, { learnerId: string; type: string }>(
          "SELECT COUNT(*) AS n FROM events WHERE learner_id = $learnerId AND type = $type",
        )
        .get({ learnerId, type })?.n ?? 0
    );
  }
}
