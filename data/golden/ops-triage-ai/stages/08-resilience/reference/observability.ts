export type LogFields = Record<string, string | number | boolean | undefined>;

// Uma linha JSON por evento: filtrável e agregável por qualquer ferramenta.
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

// Labels ordenados: {status=200,route=x} e {route=x,status=200} são a MESMA série.
export function metricKey(name: string, labels: Record<string, string>): string {
  const suffix = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return suffix ? `${name}{${suffix}}` : name;
}
