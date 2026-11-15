import { computeServiceHealth, TraceBackend } from '@traces/core';
import { Effect } from 'effect';
import {
  serializeOccurrenceBuckets,
  serializeTopIssue,
} from '#/issues/issue-serialize';
import { servicesFilter } from '#/issues/services-filter';
import { IssueStore } from '#/issues/store';
import { mapJaegerErrors } from '#/rpc/errors';
import { os } from '#/rpc/implementer';

const DAY_MS = 24 * 60 * 60 * 1000;

function hasErrors(trace: { errorSpanCount?: number }): boolean {
  return trace.errorSpanCount !== undefined && trace.errorSpanCount > 0;
}

function computeErrorRate(traces: ReadonlyArray<{ errorSpanCount?: number }>): {
  readonly errorRate: number;
  readonly sampledTraceCount: number;
} {
  const errorCount = traces.filter(hasErrors).length;
  const errorRate = traces.length > 0 ? (errorCount / traces.length) * 100 : 0;
  return { errorRate, sampledTraceCount: traces.length };
}

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

const errorRate = os.home.errorRate.effect(function* ({ input, errors }) {
  const limit = input.limit ?? 200;
  const backend = yield* TraceBackend;

  const startTime = new Date(input.startTimeMin);
  const endTime = new Date(input.startTimeMax);
  const windowMs = endTime.getTime() - startTime.getTime();
  const prevStartTime = new Date(startTime.getTime() - windowMs);

  return yield* Effect.gen(function* () {
    const currentTraces = yield* backend.searchTraces({
      service: input.service,
      startTimeMin: input.startTimeMin,
      startTimeMax: input.startTimeMax,
      limit,
    });
    const prevTraces = yield* backend.searchTraces({
      service: input.service,
      startTimeMin: prevStartTime.toISOString(),
      startTimeMax: startTime.toISOString(),
      limit,
    });

    const current = computeErrorRate(currentTraces);
    const prev = computeErrorRate(prevTraces);

    return {
      errorRate: current.errorRate,
      errorRateDelta: current.errorRate - prev.errorRate,
      sampledTraceCount: current.sampledTraceCount,
    };
  }).pipe(mapJaegerErrors(errors));
});

const serviceHealth = os.home.serviceHealth.effect(function* ({
  input,
  errors,
}) {
  const limit = input.limit ?? 200;
  const backend = yield* TraceBackend;

  return yield* Effect.gen(function* () {
    const services = yield* backend.listServices;
    return yield* Effect.forEach(
      services,
      (service) =>
        backend
          .searchTraces({
            service,
            startTimeMin: input.startTimeMin,
            startTimeMax: input.startTimeMax,
            limit,
          })
          .pipe(Effect.map((traces) => computeServiceHealth(service, traces))),
      { concurrency: 4 },
    );
  }).pipe(mapJaegerErrors(errors));
});

const recentErrorTraces = os.home.recentErrorTraces.effect(function* ({
  input,
  errors,
}) {
  const limit = input.limit ?? 50;
  const backend = yield* TraceBackend;
  const traces = yield* backend
    .searchTraces({
      service: input.service,
      startTimeMin: input.startTimeMin,
      startTimeMax: input.startTimeMax,
      limit,
    })
    .pipe(mapJaegerErrors(errors));

  return traces
    .filter(hasErrors)
    .slice(0, 6)
    .map((trace) => ({
      traceId: trace.traceId,
      rootService: trace.rootService,
      rootOperation: trace.rootOperation,
      spanCount: trace.spanCount,
      errorSpanCount: trace.errorSpanCount,
      durationMs: trace.durationMs,
      startTimeUnixNano: trace.startTimeUnixNano,
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
