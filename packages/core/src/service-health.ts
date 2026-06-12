import { computePercentiles } from './percentiles.js';
import type { TraceSummary } from './model.js';

export interface ServiceHealth {
  readonly service: string;
  readonly traceCount: number;
  readonly errorRate: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export function computeServiceHealth(
  service: string,
  traces: ReadonlyArray<TraceSummary>,
): ServiceHealth {
  if (traces.length === 0) {
    return {
      service,
      traceCount: 0,
      errorRate: 0,
      p50: null,
      p95: null,
      p99: null,
    };
  }

  const errorCount = traces.filter(
    (t) => t.errorSpanCount !== undefined && t.errorSpanCount > 0,
  ).length;
  const errorRate = (errorCount / traces.length) * 100;

  const durations = traces.map((t) => t.durationMs);
  const percentiles = computePercentiles(durations);

  return {
    service,
    traceCount: traces.length,
    errorRate,
    p50: percentiles.p50,
    p95: percentiles.p95,
    p99: percentiles.p99,
  };
}
