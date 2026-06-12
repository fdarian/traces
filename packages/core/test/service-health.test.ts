import { describe, expect, test } from 'bun:test';
import { computeServiceHealth } from '#/service-health.js';
import type { TraceSummary } from '#/model.js';

function makeTraceSummary(props: {
  durationMs: number;
  errorSpanCount?: number;
}): TraceSummary {
  return {
    traceId: 'trace-id',
    rootService: 'web',
    rootOperation: 'GET /',
    spanCount: 1,
    errorSpanCount: props.errorSpanCount,
    services: [{ name: 'web', spanCount: 1 }],
    startTimeUnixNano: '1700000000000000000',
    durationMs: props.durationMs,
  };
}

describe('computeServiceHealth', () => {
  test('returns zeroed stats for empty traces', () => {
    const result = computeServiceHealth('web', []);
    expect(result.service).toBe('web');
    expect(result.traceCount).toBe(0);
    expect(result.errorRate).toBe(0);
    expect(result.p50).toBeNull();
    expect(result.p95).toBeNull();
    expect(result.p99).toBeNull();
  });

  test('computes error rate and percentiles', () => {
    const traces: Array<TraceSummary> = [
      makeTraceSummary({ durationMs: 100, errorSpanCount: 1 }),
      makeTraceSummary({ durationMs: 200, errorSpanCount: 0 }),
      makeTraceSummary({ durationMs: 300, errorSpanCount: 1 }),
      makeTraceSummary({ durationMs: 400, errorSpanCount: 0 }),
    ];
    const result = computeServiceHealth('web', traces);
    expect(result.traceCount).toBe(4);
    expect(result.errorRate).toBe(50);
    expect(result.p50).toBe(250);
    expect(result.p95).toBe(385);
    expect(result.p99).toBe(397);
  });

  test('handles traces without errorSpanCount', () => {
    const traces: Array<TraceSummary> = [
      makeTraceSummary({ durationMs: 100 }),
      makeTraceSummary({ durationMs: 200 }),
    ];
    const result = computeServiceHealth('web', traces);
    expect(result.errorRate).toBe(0);
  });
});
