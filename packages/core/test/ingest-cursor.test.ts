import { describe, expect, test } from 'bun:test';
import { computeIngestCursorEnd } from '#/issues/ingest-cursor.js';
import type { TraceSummary } from '#/model.js';

function summary(traceId: string, startTimeUnixNano: string): TraceSummary {
  return {
    traceId,
    rootService: 'web',
    rootOperation: 'GET /',
    spanCount: 1,
    services: [{ name: 'web', spanCount: 1 }],
    startTimeUnixNano,
    durationMs: 100,
  };
}

describe('computeIngestCursorEnd', () => {
  test('advances to now when below trace limit', () => {
    const now = new Date('2026-06-12T12:00:00.000Z');
    const summaries = [
      summary('a', '1700000000000000000'),
      summary('b', '1700000001000000000'),
    ];
    const cursor = computeIngestCursorEnd(summaries, now, 200, 60000, null);
    expect(cursor.toISOString()).toBe(now.toISOString());
  });

  test('stops at oldest returned trace minus overlap when limit hit', () => {
    const now = new Date('2026-06-12T12:00:00.000Z');
    const overlapMs = 60000;
    const oldestStartMs = 1700000000000;
    const summaries = [
      summary('newer', '1700000001000000000'),
      summary('older', `${oldestStartMs}000000`),
    ];
    const cursor = computeIngestCursorEnd(summaries, now, 2, overlapMs, null);
    expect(cursor.getTime()).toBe(oldestStartMs - overlapMs);
    expect(cursor.getTime()).toBeLessThan(now.getTime());
  });

  test('advances to now when search returns no traces', () => {
    const now = new Date('2026-06-12T12:00:00.000Z');
    const cursor = computeIngestCursorEnd([], now, 10, 60000, null);
    expect(cursor.toISOString()).toBe(now.toISOString());
  });

  test('never regresses below previous cursor when limit-hit set is older', () => {
    const now = new Date('2026-06-12T12:00:00.000Z');
    const overlapMs = 60000;
    const previousCursor = new Date(1700000005000);
    const summaries = [
      summary('newer', '1700000008000000000'),
      summary('older', '1700000001000000000'),
    ];

    const cursor = computeIngestCursorEnd(
      summaries,
      now,
      2,
      overlapMs,
      previousCursor,
    );

    expect(cursor.getTime()).toBeGreaterThanOrEqual(previousCursor.getTime());
    expect(cursor.getTime()).toBe(previousCursor.getTime());
  });

  test('successive ticks keep cursor monotonically non-decreasing', () => {
    const overlapMs = 60000;
    let cursor: Date | null = null;

    const tickOne = computeIngestCursorEnd(
      [
        summary('a', '1700000005000000000'),
        summary('b', '1700000006000000000'),
      ],
      new Date(1700000010000),
      2,
      overlapMs,
      cursor,
    );
    cursor = tickOne;

    const tickTwo = computeIngestCursorEnd(
      [
        summary('c', '1700000003000000000'),
        summary('d', '1700000009000000000'),
      ],
      new Date(1700000020000),
      2,
      overlapMs,
      cursor,
    );
    expect(tickTwo.getTime()).toBeGreaterThanOrEqual(tickOne.getTime());
    cursor = tickTwo;

    const tickThree = computeIngestCursorEnd(
      [summary('e', '1700000004000000000')],
      new Date(1700000030000),
      2,
      overlapMs,
      cursor,
    );
    expect(tickThree.getTime()).toBeGreaterThanOrEqual(tickTwo.getTime());
  });
});
