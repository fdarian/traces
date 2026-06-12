import { describe, expect, test } from 'bun:test';
import type { Span, SpanEvent } from '@traces/core';
import { eventOffsetMs } from '../src/utils/span-events.js';

function makeSpan(startMs: number, endMs: number): Span {
  return {
    traceId: 'trace-1',
    spanId: 'span-a',
    name: 'span-a',
    kind: 'internal',
    startTimeUnixNano: String(startMs * 1_000_000),
    endTimeUnixNano: String(endMs * 1_000_000),
    durationMs: endMs - startMs,
    status: { code: 'ok' },
    attributes: [],
    events: [],
    resource: {
      serviceName: 'api',
      attributes: [],
    },
  };
}

describe('eventOffsetMs', () => {
  test('returns span-relative offset instead of absolute epoch', () => {
    const span = makeSpan(1_700_000_000_000, 1_700_000_001_000);
    const event: SpanEvent = {
      name: 'checkpoint',
      timestamp: 1_700_000_000_250,
      attributes: [],
    };

    expect(eventOffsetMs(event, span)).toBe(250);
  });
});
