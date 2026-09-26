CREATE TABLE IF NOT EXISTS stage_progress (
  learner_id    TEXT NOT NULL,
  journey_id    TEXT NOT NULL,
  stage_id      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'completed', 'skipped', 'skipped_known')),
  anchor        TEXT,
  time_spent_ms INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (learner_id, stage_id)
);

CREATE TABLE IF NOT EXISTS knowledge_state (
  learner_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('unknown', 'learning', 'known', 'mastered')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (learner_id, concept_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id TEXT NOT NULL,
  stage_id   TEXT NOT NULL,
  runner     TEXT NOT NULL CHECK (runner IN ('browser', 'docker')),
  passed     INTEGER NOT NULL CHECK (passed >= 0),
  total      INTEGER NOT NULL CHECK (total >= passed),
  latency_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_by_stage ON attempts (learner_id, stage_id);

CREATE TABLE IF NOT EXISTS tutor_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  learner_id TEXT NOT NULL,
  stage_id   TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tutor_by_thread ON tutor_messages (thread_id, id);

-- What developers ask to understand, per repository: product data for the future Planner.
CREATE TABLE IF NOT EXISTS journey_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id  TEXT,
  repo_owner  TEXT NOT NULL,
  repo_name   TEXT NOT NULL,
  goal_kind   TEXT NOT NULL,
  goal_target TEXT,
  goal_topic  TEXT,
  goal_note   TEXT,
  served      INTEGER NOT NULL CHECK (served IN (0, 1)),
  created_at  INTEGER NOT NULL
);

-- Append-only learning events: raw material for pedagogical metrics
-- (completion, skip rates, runs per stage, first-pass success, tutor usage, revisits).
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  stage_id   TEXT,
  type       TEXT NOT NULL,
  data       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_learner ON events (learner_id, journey_id, created_at);
