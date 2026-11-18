import { Effect } from 'effect';
import {
  emptySketch,
  type LatencySketch,
  mergeSketches,
  quantile,
} from '#/service-stats/latency-sketch';
import {
  HOUR_MS,
  MINUTE_MS,
  type ServiceCursor,
  ServiceStatsStore,
  type ServiceStatsStoreError,
  type StatsBucket,
  type StatsGap,
} from '#/service-stats/store';

export interface RangeStats {
  readonly service: string;
  readonly traceCount: number;
  readonly errorTraceCount: number;
  /** Percent of traces, 0 when there are none. */
  readonly errorRate: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly coverage: number;
  readonly exact: boolean;
  readonly collectingSince: number | null;
  readonly asOf: number;
}

interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

export interface RangePlan {
  /** Hour-resolution rows with `bucketStart` in this span. */
  readonly hours: Span | null;
  /** Minute-resolution rows with `bucketStart` in any of these spans. */
  readonly minutes: ReadonlyArray<Span>;
}

const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
const ceilMinute = (ms: number) => Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;
const ceilHour = (ms: number) => Math.ceil(ms / HOUR_MS) * HOUR_MS;

const isNonEmpty = (span: Span) => span.startMs < span.endMs;
const inSpan = (span: Span, ms: number) =>
  ms >= span.startMs && ms < span.endMs;

/**
 * Whole hours come from hour rows and the partial-hour edges from minute rows.
 * Minute rows are rounded outward to the minute, since a bucket holds traces
 * for its whole minute. An edge that starts before the minute-retention
 * cutoff is rounded outward to the hour and read from hour rows instead.
 */
export function planRange(input: {
  readonly startMs: number;
  readonly endMs: number;
  readonly nowMs: number;
  readonly minuteRetentionMs: number;
}): RangePlan {
  const from = floorMinute(input.startMs);
  const to = ceilMinute(input.endMs);
  const cutoff = input.nowMs - input.minuteRetentionMs;
  const firstWholeHour = ceilHour(from);
  const lastWholeHour = floorHour(to);

  const wholeHours: Span | null =
    firstWholeHour < lastWholeHour
      ? { startMs: firstWholeHour, endMs: lastWholeHour }
      : null;
  const edges: Span[] =
    firstWholeHour > lastWholeHour
      ? [{ startMs: from, endMs: to }]
      : [
          { startMs: from, endMs: firstWholeHour },
          { startMs: lastWholeHour, endMs: to },
        ];

  const hourSpans: Span[] = wholeHours === null ? [] : [wholeHours];
  const minutes: Span[] = [];
  for (const edge of edges.filter(isNonEmpty)) {
    if (edge.startMs < cutoff) {
      hourSpans.push({
        startMs: floorHour(edge.startMs),
        endMs: ceilHour(edge.endMs),
      });
    } else {
      minutes.push(edge);
    }
  }

  return { hours: covering(hourSpans), minutes };
}

function summarize(input: {
  readonly cursor: ServiceCursor;
  readonly startMs: number;
  readonly endMs: number;
  readonly buckets: ReadonlyArray<StatsBucket>;
  readonly gaps: ReadonlyArray<StatsGap>;
}): RangeStats {
  const effEnd = Math.min(input.endMs, input.cursor.forwardMs);
  const collectingSince =
    input.cursor.startedMs > input.startMs ? input.cursor.startedMs : null;
  const base = {
    service: input.cursor.service,
    collectingSince,
    asOf: input.cursor.forwardMs,
  };

  if (effEnd <= input.startMs) {
    return {
      ...base,
      traceCount: 0,
      errorTraceCount: 0,
      errorRate: 0,
      p50: null,
      p95: null,
      p99: null,
      coverage: 0,
      exact: true,
    };
  }

  let traceCount = 0;
  let errorTraceCount = 0;
  let sketch: LatencySketch = emptySketch();
  for (const bucket of input.buckets) {
    traceCount += bucket.traceCount;
    errorTraceCount += bucket.errorTraceCount;
    sketch = mergeSketches(sketch, bucket.latency);
  }

  const coverage =
    (effEnd - Math.max(input.startMs, input.cursor.startedMs)) /
    (effEnd - input.startMs);
  return {
    ...base,
    traceCount,
    errorTraceCount,
    errorRate: traceCount > 0 ? (errorTraceCount / traceCount) * 100 : 0,
    p50: quantile(sketch, 0.5),
    p95: quantile(sketch, 0.95),
    p99: quantile(sketch, 0.99),
    coverage: Math.min(1, Math.max(0, coverage)),
    exact: !input.gaps.some(
      (gap) => gap.startMs < effEnd && gap.endMs > input.startMs,
    ),
  };
}

function bucketsInPlan(
  buckets: ReadonlyArray<StatsBucket>,
  service: string,
  plan: RangePlan,
): StatsBucket[] {
  return buckets.filter((bucket) => {
    if (bucket.service !== service) {
      return false;
    }
    if (bucket.resolution === 'hour') {
      return plan.hours !== null && inSpan(plan.hours, bucket.bucketStart);
    }
    return plan.minutes.some((span) => inSpan(span, bucket.bucketStart));
  });
}

function covering(spans: ReadonlyArray<Span>): Span | null {
  if (spans.length === 0) {
    return null;
  }
  return {
    startMs: Math.min(...spans.map((span) => span.startMs)),
    endMs: Math.max(...spans.map((span) => span.endMs)),
  };
}

/** Union of overlapping or touching spans, so the middle of a range is never read as minutes. */
function mergeSpans(spans: ReadonlyArray<Span>): Span[] {
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1);
    if (last !== undefined && span.startMs <= last.endMs) {
      merged[merged.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, span.endMs),
      };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

/**
 * Stats for every service with a cursor that `include` accepts, sorted by
 * service name, over `[startMs, endMs)` as of the service's own cursor.
 */
export const readRangeStats = (input: {
  readonly startMs: number;
  readonly endMs: number;
  readonly nowMs: number;
  readonly minuteRetentionMs: number;
  readonly include: (service: string) => boolean;
}): Effect.Effect<
  ReadonlyArray<RangeStats>,
  ServiceStatsStoreError,
  ServiceStatsStore
> =>
  Effect.gen(function* () {
    const store = yield* ServiceStatsStore;
    const cursors = (yield* store.listCursors())
      .filter((cursor) => input.include(cursor.service))
      .sort((a, b) => a.service.localeCompare(b.service));

    const plans = new Map<string, RangePlan>();
    for (const cursor of cursors) {
      const effEnd = Math.min(input.endMs, cursor.forwardMs);
      if (effEnd > input.startMs) {
        plans.set(
          cursor.service,
          planRange({
            startMs: input.startMs,
            endMs: effEnd,
            nowMs: input.nowMs,
            minuteRetentionMs: input.minuteRetentionMs,
          }),
        );
      }
    }

    const live = [...plans.keys()];
    const hourSpan = covering(
      [...plans.values()].flatMap((plan) =>
        plan.hours === null ? [] : [plan.hours],
      ),
    );
    const minuteSpans = mergeSpans(
      [...plans.values()].flatMap((plan) => plan.minutes),
    );
    const lastEnd = Math.max(
      ...cursors.map((cursor) => Math.min(input.endMs, cursor.forwardMs)),
    );

    const hourBuckets =
      hourSpan === null
        ? []
        : yield* store.readBuckets({
            services: live,
            resolution: 'hour',
            fromMs: hourSpan.startMs,
            toMs: hourSpan.endMs,
          });
    const minuteBuckets = yield* Effect.forEach(minuteSpans, (span) =>
      store.readBuckets({
        services: live,
        resolution: 'minute',
        fromMs: span.startMs,
        toMs: span.endMs,
      }),
    ).pipe(Effect.map((rows) => rows.flat()));
    const gaps =
      live.length === 0
        ? []
        : yield* store.readGaps({
            services: live,
            fromMs: input.startMs,
            toMs: lastEnd,
          });
    const buckets = [...hourBuckets, ...minuteBuckets];

    return cursors.map((cursor) => {
      const plan = plans.get(cursor.service);
      return summarize({
        cursor,
        startMs: input.startMs,
        endMs: input.endMs,
        buckets:
          plan === undefined
            ? []
            : bucketsInPlan(buckets, cursor.service, plan),
        gaps: gaps.filter((gap) => gap.service === cursor.service),
      });
    });
  });
