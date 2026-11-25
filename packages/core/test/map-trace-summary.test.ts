import { describe, expect, test } from 'bun:test';
import { mapTraceSummary } from '#/jaeger.js';
import type { OtelTraceSummary } from '#/jaeger-schema.js';

describe('mapTraceSummary', () => {
  test('maps an omitted errorSpanCount to 0, since proto3 JSON drops zero fields', () => {
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
    expect(summary.errorSpanCount).toBe(0);
  });

  test('keeps an errorSpanCount Jaeger reports', () => {
    const summary = mapTraceSummary({
      traceId: 'abc',
      rootServiceName: 'web',
      rootOperationName: 'GET /',
      minStartTimeUnixNano: '1700000000000000000',
      maxEndTimeUnixNano: '1700000000600000000',
      spanCount: 3,
      errorSpanCount: 2,
      services: [{ name: 'web', spanCount: 3 }],
    });
    expect(summary.errorSpanCount).toBe(2);
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
