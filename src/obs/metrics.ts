/** In-memory counters and durations; shaped so a Prometheus exporter can replace it later. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, ms: number): void {
    const current = this.durations.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += ms;
    current.maxMs = Math.max(current.maxMs, ms);
    this.durations.set(name, current);
  }

  snapshot(): { counters: Record<string, number>; durations: Record<string, { count: number; totalMs: number; maxMs: number }> } {
    return { counters: Object.fromEntries(this.counters), durations: Object.fromEntries(this.durations) };
  }
}
