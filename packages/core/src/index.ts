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
export { JaegerBackendLayer } from './jaeger.js';
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
export { normalizeLevel, stripAnsi } from './logs/normalize.js';
export { pageBackwards } from './logs/paging.js';
export { Provider } from './logs/provider.js';
export {
  makeRailwaySource,
  mapRailwayHttpLog,
  mapRailwayLog,
  mapRailwayStatus,
  RAILWAY_RETENTION_NOTE,
} from './logs/railway.js';
export type { LogSource } from './logs/source.js';
export {
  makeVercelSource,
  mapBuildEvent,
  mapHttpRow,
  mapRuntimeRow,
  mapVercelDeployment,
  mapVercelStatus,
  VERCEL_RETENTION_NOTE,
} from './logs/vercel.js';
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
