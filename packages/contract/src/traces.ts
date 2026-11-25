import { oc } from '@orpc/contract';
import { Schema } from 'effect';
import { jaegerErrors, traceNotFoundErrors } from './errors.js';

export const AttributeValue = Schema.Struct({
  key: Schema.String,
  value: Schema.Json,
});

export const SpanEvent = Schema.Struct({
  name: Schema.String,
  timestamp: Schema.Number,
  attributes: Schema.Array(AttributeValue),
});

export const SpanResource = Schema.Struct({
  serviceName: Schema.String,
  attributes: Schema.Array(AttributeValue),
});

export const SpanStatus = Schema.Struct({
  code: Schema.Literals(['ok', 'error', 'unset']),
  message: Schema.optionalKey(Schema.String),
});

export const Span = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optionalKey(Schema.String),
  name: Schema.String,
  kind: Schema.String,
  startTimeUnixNano: Schema.String,
  endTimeUnixNano: Schema.String,
  durationMs: Schema.Number,
  status: SpanStatus,
  attributes: Schema.Array(AttributeValue),
  events: Schema.Array(SpanEvent),
  resource: SpanResource,
});

export const Trace = Schema.Struct({
  traceId: Schema.String,
  spans: Schema.Array(Span),
});

export const TraceSummaryService = Schema.Struct({
  name: Schema.String,
  spanCount: Schema.Number,
});

export const TraceSummary = Schema.Struct({
  traceId: Schema.String,
  rootService: Schema.String,
  rootOperation: Schema.String,
  spanCount: Schema.Number,
  errorSpanCount: Schema.Number,
  services: Schema.Array(TraceSummaryService),
  startTimeUnixNano: Schema.String,
  durationMs: Schema.Number,
});

export const SearchTracesInput = Schema.Struct({
  service: Schema.String,
  startTimeMin: Schema.String,
  startTimeMax: Schema.String,
  operation: Schema.optional(Schema.String),
  minDuration: Schema.optional(Schema.String),
  maxDuration: Schema.optional(Schema.String),
  attributes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  limit: Schema.optional(Schema.Number),
});

export const GetTraceInput = Schema.Struct({
  traceId: Schema.String,
});

export type AttributeValue = typeof AttributeValue.Type;
export type SpanEvent = typeof SpanEvent.Type;
export type SpanResource = typeof SpanResource.Type;
export type SpanStatus = typeof SpanStatus.Type;
export type Span = typeof Span.Type;
export type Trace = typeof Trace.Type;
export type TraceSummaryService = typeof TraceSummaryService.Type;
export type TraceSummary = typeof TraceSummary.Type;
export type SearchTracesInput = typeof SearchTracesInput.Type;
export type GetTraceInput = typeof GetTraceInput.Type;

export const traces = {
  listServices: oc.errors(jaegerErrors).output(Schema.Array(Schema.String)),
  listOperations: oc
    .errors(jaegerErrors)
    .input(Schema.String)
    .output(Schema.Array(Schema.String)),
  search: oc
    .errors(jaegerErrors)
    .input(SearchTracesInput)
    .output(Schema.Array(TraceSummary)),
  get: oc
    .errors({ ...jaegerErrors, ...traceNotFoundErrors })
    .input(GetTraceInput)
    .output(Trace),
};
