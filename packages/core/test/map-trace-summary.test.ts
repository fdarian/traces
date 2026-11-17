import { describe, expect, test } from 'bun:test';
import { mapTraceSummary } from '#/jaeger.js';
import type { OtelTraceSummary } from '#/jaeger-schema.js';

describe('mapTraceSummary', () => {
  test('leaves errorSpanCount undefined when Jaeger omits it', () => {
    const raw = {
      traceId: 'abc',
      rootServiceName: 'web',
      rootOperationName: 'GET /',
      minStartTimeUnixNano: '1700000000000000000',
      maxEndTimeUnixNano: '1700000000600000000',
      spanCount: 1,
      services: [{ name: 'web', spanCount: 1 }],
    } satisfies OtelTraceSummary;

    const summary = mapTraceSummary(raw);
    expect(summary.errorSpanCount).toBeUndefined();
  });

  test('computes durationMs with sub-millisecond precision', () => {
    const raw = {
      traceId: 'abc',
      rootServiceName: 'web',
      rootOperationName: 'GET /',
      minStartTimeUnixNano: '1700000000000999000',
      maxEndTimeUnixNano: '1700000000001001000',
      spanCount: 1,
      services: [{ name: 'web', spanCount: 1 }],
    } satisfies OtelTraceSummary;

    expect(mapTraceSummary(raw).durationMs).toBeCloseTo(0.002, 9);
  });
});
