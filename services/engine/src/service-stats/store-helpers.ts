import { type Column, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import {
  addDuration,
  decodeSketch,
  emptySketch,
  encodeSketch,
  type LatencySketch,
  mergeSketches,
} from '#/service-stats/latency-sketch';
import {
  type CountedTrace,
  ERROR_TRACES_PER_BUCKET,
  type ErrorTraceRow,
  HOUR_MS,
  MINUTE_MS,
  ServiceStatsStoreError,
  type StatsResolution,
} from '#/service-stats/store';

/** Max rows per statement; keeps bound parameters well under SQLite's and Postgres's limits. */
export const WRITE_CHUNK = 500;

export const RESOLUTION_MS: Record<StatsResolution, number> = {
  minute: MINUTE_MS,
  hour: HOUR_MS,
};

export class StepConflict extends Schema.TaggedError<StepConflict>()(
  'StepConflict',
  {},
) {}

export function wrapStoreError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ServiceStatsStoreError, R> {
  return Effect.mapError(effect, (cause) =>
    cause instanceof ServiceStatsStoreError
      ? cause
      : new ServiceStatsStoreError({ cause }),
  );
}

export function chunk<T>(
  items: ReadonlyArray<T>,
  size: number,
): ReadonlyArray<ReadonlyArray<T>> {
  const chunks: Array<ReadonlyArray<T>> = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function bucketStartFor(
  resolution: StatsResolution,
  startMs: number,
): number {
  const size = RESOLUTION_MS[resolution];
  return Math.floor(startMs / size) * size;
}

export function uniqueByTraceId(
  traces: ReadonlyArray<CountedTrace>,
): ReadonlyArray<CountedTrace> {
  const byId = new Map<string, CountedTrace>();
  for (const trace of traces) {
    if (!byId.has(trace.traceId)) {
      byId.set(trace.traceId, trace);
    }
  }
  return [...byId.values()];
}

export interface BucketDelta {
  readonly resolution: StatsResolution;
  readonly bucketStart: number;
  readonly traceCount: number;
  readonly errorTraceCount: number;
  readonly latency: LatencySketch;
}

export function aggregateBuckets(
  traces: ReadonlyArray<CountedTrace>,
): Effect.Effect<ReadonlyArray<BucketDelta>, ServiceStatsStoreError> {
  return Effect.try({
    try: () => aggregateBucketsUnsafe(traces),
    catch: (cause) => new ServiceStatsStoreError({ cause }),
  });
}

function aggregateBucketsUnsafe(
  traces: ReadonlyArray<CountedTrace>,
): ReadonlyArray<BucketDelta> {
  const deltas = new Map<string, BucketDelta>();
  for (const trace of traces) {
    for (const resolution of ['minute', 'hour'] as const) {
      const bucketStart = bucketStartFor(resolution, trace.startMs);
      const key = `${resolution}:${bucketStart}`;
      const current = deltas.get(key);
      deltas.set(key, {
        resolution,
        bucketStart,
        traceCount: (current?.traceCount ?? 0) + 1,
        errorTraceCount:
          (current?.errorTraceCount ?? 0) + (trace.errorSpanCount > 0 ? 1 : 0),
        latency: addDuration(
          current?.latency ?? emptySketch(),
          trace.durationMs,
        ),
      });
    }
  }
  return [...deltas.values()];
}

export interface StoredBucketCounts {
  readonly traceCount: number;
  readonly errorTraceCount: number;
  readonly latency: string;
}

export function decodeLatency(
  text: string,
): Effect.Effect<LatencySketch, ServiceStatsStoreError> {
  return Effect.try({
    try: () => decodeSketch(text),
    catch: (cause) => new ServiceStatsStoreError({ cause }),
  });
}

export function mergeBucket(
  delta: BucketDelta,
  existing: StoredBucketCounts | undefined,
): Effect.Effect<StoredBucketCounts, ServiceStatsStoreError> {
  return Effect.gen(function* () {
    if (existing === undefined) {
      return {
        traceCount: delta.traceCount,
        errorTraceCount: delta.errorTraceCount,
        latency: encodeSketch(delta.latency),
      };
    }
    const stored = yield* decodeLatency(existing.latency);
    return {
      traceCount: existing.traceCount + delta.traceCount,
      errorTraceCount: existing.errorTraceCount + delta.errorTraceCount,
      latency: encodeSketch(mergeSketches(stored, delta.latency)),
    };
  });
}

export function errorTraceRows(
  service: string,
  traces: ReadonlyArray<CountedTrace>,
): ReadonlyArray<ErrorTraceRow> {
  return traces
    .filter((trace) => trace.errorSpanCount > 0)
    .map((trace) => ({
      service,
      traceId: trace.traceId,
      startMs: trace.startMs,
      rootService: trace.rootService,
      rootOperation: trace.rootOperation,
      spanCount: trace.spanCount,
      errorSpanCount: trace.errorSpanCount,
      durationMs: trace.durationMs,
    }));
}

/** `excluded.<column>` for use in `onConflictDoUpdate` set clauses. */
export function excluded(column: Column) {
  return sql`excluded.${sql.identifier(column.name)}`;
}

/** Delete-rank condition shared by both dialects: rows past the Nth newest per (service, bucket). */
export function rankedErrorTraceDelete(input: {
  readonly table: string;
  readonly bucketMs: number;
  readonly rangeCondition: ReturnType<typeof sql>;
}) {
  const table = sql.identifier(input.table);
  const bucketMs = sql.raw(String(input.bucketMs));
  const keep = sql.raw(String(ERROR_TRACES_PER_BUCKET));
  return sql`
    DELETE FROM ${table}
    WHERE ("service", "traceId") IN (
      SELECT "service", "traceId" FROM (
        SELECT "service", "traceId",
          ROW_NUMBER() OVER (
            PARTITION BY "service", "startMs" / ${bucketMs}
            ORDER BY "startMs" DESC, "traceId" DESC
          ) AS "rn"
        FROM ${table}
        WHERE ${input.rangeCondition}
      ) AS "ranked"
      WHERE "rn" > ${keep}
    )
  `;
}
