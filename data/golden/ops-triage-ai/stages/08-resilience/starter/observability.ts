export type LogFields = Record<string, string | number | boolean | undefined>;

export function logLine(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): string {
  return JSON.stringify({ level, event, ...fields });
}

export class Metrics {
  private readonly counters = new Map<string, number>();

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}

export function metricKey(name: string, labels: Record<string, string>): string {
  // TODO: "name" sem labels; "name{a=1,b=2}" com labels ORDENADOS por chave.
  return name;
}
