export type {
  TraceBackend as TraceBackendInterface,
  TraceQuery,
} from './backend.js';
export { TraceBackend } from './backend.js';

export {
  JaegerBadResponse,
  JaegerUnreachable,
  TraceNotFound,
} from './errors.js';
export {
  IssueNotFound,
  IssueStoreError,
} from './issues/errors.js';
export {
  buildIssueTitle,
  fingerprintFromErrorSpan,
  fingerprintFromException,
  hashFingerprint,
} from './issues/fingerprint.js';
export {
  IngesterLayer,
  runIngester,
  runIngestOnce,
} from './issues/ingester.js';
export { IssueStoreLayer } from './issues/issue-store-layer.js';
export type {
  HistogramGranularity,
  Issue,
  IssueDetail,
  IssueStatus,
  IssueStoreStats,
  ListIssuesFilter,
  ListIssuesResult,
  ListIssuesSummary,
  Occurrence,
  OccurrenceBucket,
  PaginatedOccurrences,
  TopIssue,
  TrendBucket,
  UpsertOccurrenceInput,
} from './issues/model.js';
export { OCCURRENCES_PAGE_SIZE } from './issues/model.js';
export { normalizeExceptionMessage } from './issues/normalize-message.js';
export { PgIssueStoreLayer } from './issues/pg-store.js';
export { SqliteIssueStoreLayer } from './issues/sqlite-store.js';
export { parseTopInAppStackFrame } from './issues/stack-frame.js';
export type { IssueStore as IssueStoreInterface } from './issues/store.js';
export {
  IssueStore,
  MAX_OCCURRENCES_PER_ISSUE,
} from './issues/store.js';
export { isRegressedIssue } from './issues/store-helpers.js';
export { JaegerBackendLayer } from './jaeger.js';
export type {
  AttributeValue,
  ExceptionInfo,
  Span,
  SpanEvent,
  SpanResource,
  SpanStatus,
  StatusCode,
  Trace,
  TraceSummary,
  TraceSummaryService,
} from './model.js';
export {
  computePercentiles,
  percentile,
} from './percentiles.js';
export {
  computeServiceHealth,
} from './service-health.js';
export type {
  ServiceHealth,
} from './service-health.js';
export {
  extractExceptionInfo,
  normalizeAttribute,
  normalizeAttributes,
  normalizeAttributeValue,
  normalizeDurationMs,
  normalizeSpanEvent,
  normalizeSpanEvents,
  normalizeStatusCode,
  normalizeTimestamp,
  normalizeTimestampToMs,
} from './normalize.js';
export type {
  SerializableAttributeValue,
  SerializableJson,
} from './serialize.js';
export { serializeAttribute, serializeValue } from './serialize.js';
