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
