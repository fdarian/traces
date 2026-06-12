import type { TraceSummary } from '../model.js';

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
): Date {
  if (summaries.length === 0 || summaries.length < traceLimit) {
    return now;
  }

  const oldestStartMs = oldestTraceStartMs(summaries);
  if (oldestStartMs === null) {
    return now;
  }

  return new Date(oldestStartMs - overlapMs);
}
