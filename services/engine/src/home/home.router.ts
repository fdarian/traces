import { Clock, Effect } from 'effect';
import { excludedServicesConfig } from '#/issues/excluded-services';
import {
  serializeOccurrenceBuckets,
  serializeTopIssue,
} from '#/issues/issue-serialize';
import { servicesFilter } from '#/issues/services-filter';
import { IssueStore } from '#/issues/store';
import { os } from '#/rpc/implementer';
import { readRangeStats } from '#/service-stats/range-stats';
import { minuteRetentionMsConfig } from '#/service-stats/stats-ingester';
import { ServiceStatsStore } from '#/service-stats/store';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ERROR_TRACE_LIMIT = 6;
const PREVIOUS_WINDOW_MIN_COVERAGE = 0.9;
const MINUTE_MS = 60_000;

/**
 * Stats buckets are whole minutes and range reads round outward, so unaligned
 * bounds would make adjacent windows both read the minute they meet in.
 */
const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
const minuteAlignedWindow = (input: {
  readonly startTimeMin: string;
  readonly startTimeMax: string;
}) => ({
  startMs: floorToMinute(new Date(input.startTimeMin).getTime()),
  endMs: floorToMinute(new Date(input.startTimeMax).getTime()),
});

const stats = os.home.stats.effect(function* ({ input }) {
  const store = yield* IssueStore;
  return yield* store.getStats(
    servicesFilter(input.services),
    new Date(input.startTime),
    new Date(input.endTime),
  );
});

const trend = os.home.trend.effect(function* ({ input }) {
  const store = yield* IssueStore;
  const buckets = yield* store.getOccurrenceTrend(
    servicesFilter(input.services),
    new Date(input.startTime),
    new Date(input.endTime),
  );
  return serializeOccurrenceBuckets(buckets);
});

const topIssues = os.home.topIssues.effect(function* ({ input }) {
  const limit = input.limit ?? 8;
  const since =
    input.since !== undefined
      ? new Date(input.since)
      : new Date(Date.now() - DAY_MS);

  const store = yield* IssueStore;
  const issues = yield* store.getTopUnresolvedIssues(
    servicesFilter(input.services),
    limit,
  );
  const histograms = yield* store.getOccurrenceHistograms(
    issues.map((issue) => issue.id),
    'hour',
    since,
  );

  const serializedHistograms = new Map<
    number,
    ReadonlyArray<{ readonly bucketStart: number; readonly count: number }>
  >();
  for (const issue of issues) {
    serializedHistograms.set(
      issue.id,
      serializeOccurrenceBuckets(histograms.get(issue.id) ?? []),
    );
  }

  return {
    issues: issues.map(serializeTopIssue),
    histograms: serializedHistograms,
  };
});

const errorRate = os.home.errorRate.effect(function* ({ input }) {
  const window = minuteAlignedWindow(input);
  const startMs = window.startMs;
  const endMs = window.endMs;
  const windowMs = endMs - startMs;
  const minuteRetentionMs = yield* minuteRetentionMsConfig;
  const nowMs = yield* Clock.currentTimeMillis;
  const range = (from: number, to: number) =>
    readRangeStats({
      startMs: from,
      endMs: to,
      nowMs,
      minuteRetentionMs,
      include: (service) => service === input.service,
    }).pipe(Effect.map((stats) => stats[0]));

  const current = yield* range(startMs, endMs);
  if (current === undefined) {
    return {
      errorRate: 0,
      errorRateDelta: null,
      traceCount: 0,
      coverage: 0,
      exact: true,
      collectingSince: null,
      asOf: startMs,
    };
  }
  const previous = yield* range(startMs - windowMs, startMs);
  const deltaIsMeaningful =
    previous !== undefined &&
    previous.coverage >= PREVIOUS_WINDOW_MIN_COVERAGE &&
    previous.traceCount > 0;

  return {
    errorRate: current.errorRate,
    errorRateDelta: deltaIsMeaningful
      ? current.errorRate - previous.errorRate
      : null,
    traceCount: current.traceCount,
    coverage: current.coverage,
    exact: current.exact,
    collectingSince: current.collectingSince,
    asOf: current.asOf,
  };
});

const serviceHealth = os.home.serviceHealth.effect(function* ({ input }) {
  const excludedServices = yield* excludedServicesConfig;
  const window = minuteAlignedWindow(input);
  const stats = yield* readRangeStats({
    startMs: window.startMs,
    endMs: window.endMs,
    nowMs: yield* Clock.currentTimeMillis,
    minuteRetentionMs: yield* minuteRetentionMsConfig,
    include: (service) => !excludedServices.has(service),
  });
  return {
    services: stats.map((entry) => ({
      service: entry.service,
      traceCount: entry.traceCount,
      errorRate: entry.errorRate,
      p50: entry.p50,
      p95: entry.p95,
      p99: entry.p99,
      coverage: entry.coverage,
      exact: entry.exact,
      collectingSince: entry.collectingSince,
      asOf: entry.asOf,
    })),
  };
});

const recentErrorTraces = os.home.recentErrorTraces.effect(function* ({
  input,
}) {
  const store = yield* ServiceStatsStore;
  const window = minuteAlignedWindow(input);
  const rows = yield* store.recentErrorTraces({
    service: input.service,
    fromMs: window.startMs,
    toMs: window.endMs,
    limit: RECENT_ERROR_TRACE_LIMIT,
  });
  return rows.map((row) => ({
    traceId: row.traceId,
    rootService: row.rootService,
    rootOperation: row.rootOperation,
    spanCount: row.spanCount,
    errorSpanCount: row.errorSpanCount,
    durationMs: row.durationMs,
    startTimeUnixNano: (BigInt(row.startMs) * 1_000_000n).toString(),
  }));
});

export const homeRouter = {
  stats,
  trend,
  topIssues,
  errorRate,
  serviceHealth,
  recentErrorTraces,
};
