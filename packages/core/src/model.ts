import { Schema } from 'effect';
import { nanoToIso } from './normalize.js';

export type StatusCode = 'ok' | 'error' | 'unset';

export interface AttributeValue {
  readonly key: string;
  readonly value: unknown;
}

export interface SpanEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes: ReadonlyArray<AttributeValue>;
}

export interface ExceptionInfo {
  readonly type: string;
  readonly message: string;
  readonly stacktrace: string;
}

export interface SpanStatus {
  readonly code: StatusCode;
  readonly message?: string;
}

export interface SpanResource {
  readonly serviceName: string;
  readonly attributes: ReadonlyArray<AttributeValue>;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly attributes: ReadonlyArray<AttributeValue>;
  readonly events: ReadonlyArray<SpanEvent>;
  readonly resource: SpanResource;
}

export interface Trace {
  readonly traceId: string;
  readonly spans: ReadonlyArray<Span>;
}

export interface TraceSummaryService {
  readonly name: string;
  readonly spanCount: number;
}

/** Root service and operation of a trace with no root span (e.g. the root was never sampled or ingested). */
export const UNKNOWN_ROOT = 'unknown';

export interface TraceSummary {
  readonly traceId: string;
  readonly rootService: string;
  readonly rootOperation: string;
  readonly spanCount: number;
  readonly errorSpanCount: number;
  readonly services: ReadonlyArray<TraceSummaryService>;
  readonly startTimeUnixNano: string;
  readonly durationMs: number;
}

export const TraceRow = Schema.Struct({
  traceId: Schema.String,
  rootService: Schema.String,
  rootOperation: Schema.String,
  /** ISO timestamp with nanosecond precision, so it sorts and pages without loss. */
  startTs: Schema.String,
  durationMs: Schema.Number,
  spanCount: Schema.Number,
  errorSpanCount: Schema.Number,
  services: Schema.Array(Schema.String),
});
export type TraceRow = typeof TraceRow.Type;

export const toTraceRow = (summary: TraceSummary): TraceRow => ({
  traceId: summary.traceId,
  rootService: summary.rootService,
  rootOperation: summary.rootOperation,
  startTs: nanoToIso(summary.startTimeUnixNano),
  durationMs: summary.durationMs,
  spanCount: summary.spanCount,
  errorSpanCount: summary.errorSpanCount,
  services: summary.services.map((service) => service.name),
});
