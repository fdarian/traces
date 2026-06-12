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
