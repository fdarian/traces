import type { TraceSummary } from '@traces/core';
import { maxTimestamp } from '#/issues/store-helpers';

export function oldestTraceStartMs(
  summaries: ReadonlyArray<TraceSummary>,
): number | null {
  const first = summaries[0];
  if (first === undefined) {
    return null;
  }

  let oldestNanos = BigInt(first.startTimeUnixNano);
  for (const summary of summaries) {
    const startNanos = BigInt(summary.startTimeUnixNano);
    if (startNanos < oldestNanos) {
      oldestNanos = startNanos;
    }
  }

  return Number(oldestNanos / BigInt(1000000));
}

export function computeIngestCursorEnd(
  summaries: ReadonlyArray<TraceSummary>,
  now: Date,
  traceLimit: number,
  overlapMs: number,
  previousCursor: Date | null,
): Date {
  let computed: Date;
  if (summaries.length === 0 || summaries.length < traceLimit) {
    computed = now;
  } else {
    const oldestStartMs = oldestTraceStartMs(summaries);
    if (oldestStartMs === null) {
      computed = now;
    } else {
      computed = new Date(oldestStartMs - overlapMs);
    }
  }

  if (previousCursor === null) {
    return computed;
  }

  return maxTimestamp(previousCursor, computed);
}
