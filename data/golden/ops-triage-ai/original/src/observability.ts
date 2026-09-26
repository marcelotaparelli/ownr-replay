export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  requestId?: string;
  runId?: string;
  decisionId?: string;
  status?: number | string;
  durationMs?: number;
  decisionSource?: string;
  requiresHumanReview?: boolean;
  code?: string;
  route?: string;
  count?: number;
}

export interface AppLogger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

export const stdoutLogger: AppLogger = {
  log(level, event, fields = {}) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
  },
};

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { total: number; count: number }>();

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    const current = this.durations.get(key) ?? { total: 0, count: 0 };
    current.total += value;
    current.count += 1;
    this.durations.set(key, current);
  }

  set(name: string, value: number, labels: Record<string, string> = {}): void {
    this.counters.set(metricKey(name, labels), value);
  }

  snapshot(): Record<string, unknown> {
    const counters: Record<string, number> = {};
    const durations: Record<string, { count: number; totalMs: number }> = {};
    for (const [key, value] of this.counters) counters[key] = value;
    for (const [key, value] of this.durations) durations[key] = { count: value.count, totalMs: value.total };
    return { counters, durations };
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  const suffix = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return suffix ? `${name}{${suffix}}` : name;
}

export function safeRequestId(value: string | null): string {
  if (value && /^[A-Za-z0-9._-]{1,128}$/.test(value)) return value;
  return crypto.randomUUID();
}
