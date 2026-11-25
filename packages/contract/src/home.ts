import { oc } from '@orpc/contract';
import { Schema } from 'effect';
import { OccurrenceBucket } from './issues.js';

export const HomeStatsInput = Schema.Struct({
  services: Schema.optional(Schema.Array(Schema.String)),
  startTime: Schema.Number,
  endTime: Schema.Number,
});

export const HomeStats = Schema.Struct({
  occurrenceCount: Schema.Number,
  occurrenceDelta: Schema.Number,
  activeIssueCount: Schema.Number,
  activeIssueDelta: Schema.Number,
  serviceCount: Schema.Number,
  serviceDelta: Schema.Number,
});

export const HomeTrendInput = HomeStatsInput;

export const TrendBucket = Schema.Struct({
  bucketStart: Schema.Number,
  count: Schema.Number,
});

export const HomeTopIssuesInput = Schema.Struct({
  services: Schema.optional(Schema.Array(Schema.String)),
  limit: Schema.optional(Schema.Number),
  since: Schema.optional(Schema.Number),
});

export const TopIssue = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  service: Schema.String,
  occurrenceCount: Schema.Number,
  lastSeen: Schema.Number,
});

export const HomeTopIssuesResult = Schema.Struct({
  issues: Schema.Array(TopIssue),
  histograms: Schema.ReadonlyMap(Schema.Number, Schema.Array(OccurrenceBucket)),
});

export const HomeErrorRateInput = Schema.Struct({
  service: Schema.String,
  startTimeMin: Schema.String,
  startTimeMax: Schema.String,
});

const RangeCoverage = {
  /** 0 to 1: the share of the range (up to `asOf`) that stats collection covered. */
  coverage: Schema.Number,
  /** False when a sampled interval overlaps the range, so counts are lower bounds. */
  exact: Schema.Boolean,
  /** Unix ms when collection began, when that is after the range start. */
  collectingSince: Schema.NullOr(Schema.Number),
  /** Unix ms through which traces have been counted. */
  asOf: Schema.Number,
};

export const HomeErrorRateResult = Schema.Struct({
  errorRate: Schema.Number,
  errorRateDelta: Schema.NullOr(Schema.Number),
  traceCount: Schema.Number,
  ...RangeCoverage,
});

export const HomeServiceHealthInput = Schema.Struct({
  startTimeMin: Schema.String,
  startTimeMax: Schema.String,
});

export const ServiceHealth = Schema.Struct({
  service: Schema.String,
  traceCount: Schema.Number,
  errorRate: Schema.Number,
  p50: Schema.NullOr(Schema.Number),
  p95: Schema.NullOr(Schema.Number),
  p99: Schema.NullOr(Schema.Number),
  ...RangeCoverage,
});

export const HomeServiceHealthResult = Schema.Struct({
  services: Schema.Array(ServiceHealth),
});

export const HomeRecentErrorTracesInput = HomeErrorRateInput;

export const ErrorTraceSummary = Schema.Struct({
  traceId: Schema.String,
  rootService: Schema.String,
  rootOperation: Schema.String,
  spanCount: Schema.Number,
  errorSpanCount: Schema.Number,
  durationMs: Schema.Number,
  startTimeUnixNano: Schema.String,
});

export type HomeStatsInput = typeof HomeStatsInput.Type;
export type HomeStats = typeof HomeStats.Type;
export type TrendBucket = typeof TrendBucket.Type;
export type HomeTopIssuesInput = typeof HomeTopIssuesInput.Type;
export type TopIssue = typeof TopIssue.Type;
export type HomeTopIssuesResult = typeof HomeTopIssuesResult.Type;
export type HomeErrorRateInput = typeof HomeErrorRateInput.Type;
export type HomeErrorRateResult = typeof HomeErrorRateResult.Type;
export type HomeServiceHealthInput = typeof HomeServiceHealthInput.Type;
export type HomeServiceHealthResult = typeof HomeServiceHealthResult.Type;
export type ServiceHealth = typeof ServiceHealth.Type;
export type ErrorTraceSummary = typeof ErrorTraceSummary.Type;

export const home = {
  stats: oc.input(HomeStatsInput).output(HomeStats),
  trend: oc.input(HomeTrendInput).output(Schema.Array(TrendBucket)),
  topIssues: oc.input(HomeTopIssuesInput).output(HomeTopIssuesResult),
  errorRate: oc.input(HomeErrorRateInput).output(HomeErrorRateResult),
  serviceHealth: oc
    .input(HomeServiceHealthInput)
    .output(HomeServiceHealthResult),
  recentErrorTraces: oc
    .input(HomeRecentErrorTracesInput)
    .output(Schema.Array(ErrorTraceSummary)),
};
