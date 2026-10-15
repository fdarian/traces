export type {
  TraceBackend as TraceBackendInterface,
  TraceQuery,
} from './backend.js';
export { TraceBackend } from './backend.js';

export {
  JaegerBadResponse,
  JaegerUnreachable,
  TraceBackendUnauthorized,
  TraceErrorCountsUnavailable,
  TraceNotFound,
} from './errors.js';
export {
  buildIssueTitle,
  fingerprintFromErrorSpan,
  fingerprintFromException,
  hashFingerprint,
} from './issues/fingerprint.js';
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
export { isRegressedIssue } from './issues/regression.js';
export { parseTopInAppStackFrame } from './issues/stack-frame.js';
export type { JaegerBackendOptions } from './jaeger.js';
export { JaegerBackendLayer, makeJaegerBackend } from './jaeger.js';
export type { ProviderError } from './logs/errors.js';
export {
  InvalidCursor,
  ProviderAuthError,
  ProviderNotFound,
  ProviderRequestError,
  ProviderResponseInvalid,
} from './logs/errors.js';
export type { ErrorGroup } from './logs/errors-group.js';
export {
  byFrequency,
  errorFingerprint,
  firstLine,
  groupErrors,
} from './logs/errors-group.js';
export type {
  Cursor,
  DeploymentCommit,
  DeploymentPage,
  DeploymentQuery,
  DeploymentStatus,
  LogLevel,
  LogPage,
  LogQuery,
  LogRequest,
  LogSourceKind,
  RailwayTarget,
  ServiceTarget,
  VercelTarget,
} from './logs/model.js';
export {
  Cursor as CursorSchema,
  Deployment,
  decodeCursor,
  encodeCursor,
  LogRecord,
} from './logs/model.js';
export { coalesceMultiline } from './logs/multiline.js';
export { normalizeLevel, shortHash, stripAnsi } from './logs/normalize.js';
export type { BackwardPage, PageResume } from './logs/paging.js';
export { pageBackwards } from './logs/paging.js';
export { Provider } from './logs/provider.js';
export {
  makeRailwaySource,
  mapRailwayHttpLog,
  mapRailwayLog,
  mapRailwayStatus,
  RAILWAY_RETENTION_NOTE,
} from './logs/railway/index.js';
export type { LogSource } from './logs/source.js';
export {
  makeVercelSource,
  mapBuildEvent,
  mapHttpRow,
  mapRuntimeRow,
  mapVercelDeployment,
  mapVercelStatus,
  VERCEL_RETENTION_NOTE,
} from './logs/vercel/index.js';
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
export { TraceRow, toTraceRow } from './model.js';
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
export type { TraceErrorScanResult } from './traces/error-scan.js';
export {
  groupTraceErrors,
  memoizeGetTrace,
  scanTraceErrors,
} from './traces/error-scan.js';
export type { ErrorScanMode, ErrorTraceScan } from './traces/paging.js';
export {
  errorSearchAttributes,
  fromTraceCursor,
  pageTraces,
  scanErrorTraces,
  toTraceCursor,
  traceFetchSize,
} from './traces/paging.js';
export type { SpanKind } from './traces/span-rows.js';
export { normalizeSpanKind, SpanRow, toSpanRows } from './traces/span-rows.js';
