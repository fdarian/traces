import { Context, type Effect, Schema } from 'effect';
import type { LatencySketch } from '#/service-stats/latency-sketch';

export class ServiceStatsStoreError extends Schema.TaggedError<ServiceStatsStoreError>()(
  'ServiceStatsStoreError',
  {
    cause: Schema.Defect(),
  },
) {}

export type StatsResolution = 'minute' | 'hour';

export interface ServiceCursor {
  readonly service: string;
  readonly startedMs: number;
  readonly forwardMs: number;
}

export interface CountedTrace {
  readonly traceId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly errorSpanCount: number;
  readonly rootService: string;
  readonly rootOperation: string;
  readonly spanCount: number;
}

export interface CommitStepInput {
  readonly service: string;
  /** Null when the service has no cursor yet. */
  readonly expectedForwardMs: number | null;
  readonly startedMs: number;
  readonly newForwardMs: number;
  readonly nowMs: number;
  readonly traces: ReadonlyArray<CountedTrace>;
  readonly gap: { readonly startMs: number; readonly endMs: number } | null;
}

export interface StatsBucket {
  readonly resolution: StatsResolution;
  readonly bucketStart: number;
  readonly service: string;
  readonly traceCount: number;
  readonly errorTraceCount: number;
  readonly latency: LatencySketch;
}

export interface StatsGap {
  readonly service: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface ErrorTraceRow {
  readonly service: string;
  readonly traceId: string;
  readonly startMs: number;
  readonly rootService: string;
  readonly rootOperation: string;
  readonly spanCount: number;
  readonly errorSpanCount: number;
  readonly durationMs: number;
}

export interface ServiceStatsStore {
  readonly listCursors: () => Effect.Effect<
    ReadonlyArray<ServiceCursor>,
    ServiceStatsStoreError,
    never
  >;
  readonly getCursor: (
    service: string,
  ) => Effect.Effect<
    { readonly startedMs: number; readonly forwardMs: number } | null,
    ServiceStatsStoreError,
    never
  >;
  /** One transaction; 'conflict' means another writer moved the cursor and nothing was written. */
  readonly commitStep: (
    input: CommitStepInput,
  ) => Effect.Effect<'committed' | 'conflict', ServiceStatsStoreError, never>;
  /** Rows with `bucketStart` in `[fromMs, toMs)`. Undefined or empty `services` means all services. */
  readonly readBuckets: (input: {
    readonly services: ReadonlyArray<string> | undefined;
    readonly resolution: StatsResolution;
    readonly fromMs: number;
    readonly toMs: number;
  }) => Effect.Effect<
    ReadonlyArray<StatsBucket>,
    ServiceStatsStoreError,
    never
  >;
  /** Gaps overlapping `[fromMs, toMs)`. Undefined or empty `services` means all services. */
  readonly readGaps: (input: {
    readonly services: ReadonlyArray<string> | undefined;
    readonly fromMs: number;
    readonly toMs: number;
  }) => Effect.Effect<ReadonlyArray<StatsGap>, ServiceStatsStoreError, never>;
  /** Newest first, `startMs` in `[fromMs, toMs)`. */
  readonly recentErrorTraces: (input: {
    readonly service: string;
    readonly fromMs: number;
    readonly toMs: number;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<ErrorTraceRow>,
    ServiceStatsStoreError,
    never
  >;
  readonly prune: (input: {
    readonly nowMs: number;
    readonly minuteRetentionMs: number;
    readonly hourRetentionMs: number;
  }) => Effect.Effect<void, ServiceStatsStoreError, never>;
}

export const ServiceStatsStore = Context.Service<ServiceStatsStore>(
  'traces/ServiceStatsStore',
);

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
/**
 * How far the cursor must advance past the step that counted a trace before its
 * dedupe row is pruned. Keyed on the counting step, not the trace start, so a
 * long-running trace is remembered as long as a short one.
 */
export const SEEN_RETENTION_MS = 10 * MINUTE_MS;
export const ERROR_TRACES_PER_BUCKET = 6;
