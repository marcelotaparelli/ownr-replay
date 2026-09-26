import type { KnowledgeLevel, ProgressUpdate, StageProgress, StageStatus } from "../src/domain/progress.ts";
import { api } from "./api.ts";

/**
 * Local-first progress: the UI reads and writes localStorage synchronously
 * (instant navigation), and changes are pushed to the server in the background.
 * Failed pushes wait in an outbox and are retried on the next load/online event.
 */

export type LocalStage = { status: StageStatus; anchor?: string; updatedAt: number };
export type LocalJourney = {
  stages: Record<string, LocalStage>;
  known: Record<string, KnowledgeLevel>;
  lastStageId?: string;
  /** Summary card to show once, right after completing a stage. */
  justCompleted?: string;
};

type OutboxItem = { stageId: string; update: ProgressUpdate };

const VERSION = "rr:v1";
const OUTBOX_KEY = `${VERSION}:outbox`;
const OUTBOX_LIMIT = 200;

const empty = (): LocalJourney => ({ stages: {}, known: {} });

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage blocked: the server copy remains the source of truth.
  }
}

export class ProgressStore {
  private data: LocalJourney;

  constructor(private readonly journeyId: string) {
    this.data = read(this.key(), empty());
  }

  get snapshot(): Readonly<LocalJourney> {
    return this.data;
  }

  status(stageId: string): StageStatus {
    return this.data.stages[stageId]?.status ?? "not_started";
  }

  isKnown(conceptId: string): boolean {
    const level = this.data.known[conceptId];
    return level === "known" || level === "mastered";
  }

  setStatus(stageId: string, status: StageStatus, extra: { timeSpentMs?: number; knownConcepts?: string[] } = {}): void {
    const current = this.data.stages[stageId];
    this.data.stages[stageId] = { ...current, status, updatedAt: Date.now() };
    for (const conceptId of extra.knownConcepts ?? []) this.data.known[conceptId] = "known";
    if (status === "completed") this.data.justCompleted = stageId;
    this.save();
    push({ stageId, update: { status, ...extra, ...(current?.anchor ? { anchor: current.anchor } : {}) } });
  }

  /** Called often (scroll); stays local until the next status push or leave. */
  setAnchor(stageId: string, anchor: string): void {
    const current = this.data.stages[stageId];
    if (!current || current.anchor === anchor) return;
    this.data.stages[stageId] = { ...current, anchor };
    this.save();
  }

  leave(stageId: string, timeSpentMs: number): void {
    const current = this.data.stages[stageId];
    if (!current || timeSpentMs < 1_000) return;
    push({ stageId, update: { status: current.status, timeSpentMs: Math.round(timeSpentMs), ...(current.anchor ? { anchor: current.anchor } : {}) } });
  }

  setLast(stageId: string): void {
    this.data.lastStageId = stageId;
    this.save();
  }

  consumeJustCompleted(): string | undefined {
    const id = this.data.justCompleted;
    if (id) {
      delete this.data.justCompleted;
      this.save();
    }
    return id;
  }

  toggleKnown(conceptId: string): KnowledgeLevel {
    const next: KnowledgeLevel = this.isKnown(conceptId) ? "unknown" : "known";
    this.data.known[conceptId] = next;
    this.save();
    api.setKnowledge(this.journeyId, [conceptId], next).catch(reportSyncFailure);
    return next;
  }

  /** Server data wins only where it is newer than what this device knows. */
  merge(server: { stages: StageProgress[]; knowledge: { conceptId: string; state: KnowledgeLevel }[] }): void {
    for (const remote of server.stages) {
      const local = this.data.stages[remote.stageId];
      if (!local || remote.updatedAt > local.updatedAt) {
        this.data.stages[remote.stageId] = {
          status: remote.status,
          updatedAt: remote.updatedAt,
          ...(remote.anchor ? { anchor: remote.anchor } : {}),
        };
      }
    }
    for (const { conceptId, state } of server.knowledge) this.data.known[conceptId] ??= state;
    this.save();
  }

  private key(): string {
    return `${VERSION}:journey:${this.journeyId}`;
  }

  private save(): void {
    write(this.key(), this.data);
  }
}

function push(item: OutboxItem): void {
  api.progressUpdate(item.stageId, item.update).catch(() => {
    const outbox = read<OutboxItem[]>(OUTBOX_KEY, []);
    write(OUTBOX_KEY, [...outbox, item].slice(-OUTBOX_LIMIT));
  });
}

export async function flushOutbox(): Promise<void> {
  const outbox = read<OutboxItem[]>(OUTBOX_KEY, []);
  if (outbox.length === 0) return;
  write(OUTBOX_KEY, []);
  // Sequential on purpose: order matters for status transitions.
  for (const item of outbox) {
    try {
      await api.progressUpdate(item.stageId, item.update);
    } catch {
      push(item);
    }
  }
}

export function drafts(stageId: string) {
  const key = (path: string) => `${VERSION}:draft:${stageId}:${path}`;
  return {
    load: (path: string): string | undefined => read<string | undefined>(key(path), undefined),
    save: (path: string, content: string): void => write(key(path), content),
    clear: (path: string): void => {
      try {
        localStorage.removeItem(key(path));
      } catch {
        // Nothing to clear when storage is unavailable.
      }
    },
  };
}

/** Background sync is best-effort; failures are surfaced to devtools, never to the flow. */
export function reportSyncFailure(error: unknown): void {
  console.warn(JSON.stringify({ event: "sync_failed", error: error instanceof Error ? error.message : String(error) }));
}
