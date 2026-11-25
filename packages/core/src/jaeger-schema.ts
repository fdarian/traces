import * as S from 'effect/Schema';

export const OtelAttributeValueSchema = S.Union([
  S.Struct({ stringValue: S.String }),
  S.Struct({ intValue: S.Union([S.String, S.Number]) }),
  S.Struct({ boolValue: S.Boolean }),
  S.Struct({ doubleValue: S.Number }),
  S.Struct({ arrayValue: S.Unknown }),
  S.Struct({ kvlistValue: S.Unknown }),
]);

export type OtelAttributeValue = typeof OtelAttributeValueSchema.Type;

export const OtelAttributeSchema = S.Struct({
  key: S.String,
  value: OtelAttributeValueSchema,
});

export type OtelAttribute = typeof OtelAttributeSchema.Type;

export const OtelEventSchema = S.Struct({
  timeUnixNano: S.Union([S.String, S.Number]),
  name: S.String,
  attributes: S.optional(S.Array(OtelAttributeSchema)),
});

export type OtelEvent = typeof OtelEventSchema.Type;

export const OtelStatusSchema = S.Struct({
  code: S.optional(S.Union([S.String, S.Number])),
  message: S.optional(S.String),
});

export type OtelStatus = typeof OtelStatusSchema.Type;

export const OtelSpanSchema = S.Struct({
  traceId: S.String,
  spanId: S.String,
  parentSpanId: S.optional(S.String),
  name: S.String,
  kind: S.optional(S.Union([S.String, S.Number])),
  startTimeUnixNano: S.Union([S.String, S.Number]),
  endTimeUnixNano: S.Union([S.String, S.Number]),
  attributes: S.optional(S.Array(OtelAttributeSchema)),
  events: S.optional(S.Array(OtelEventSchema)),
  status: S.optional(OtelStatusSchema),
});

export type OtelSpan = typeof OtelSpanSchema.Type;

export const OtelResourceSchema = S.Struct({
  attributes: S.optional(S.Array(OtelAttributeSchema)),
});

export type OtelResource = typeof OtelResourceSchema.Type;

export const OtelScopeSchema = S.Struct({
  name: S.optional(S.String),
  version: S.optional(S.String),
});

export type OtelScope = typeof OtelScopeSchema.Type;

export const OtelScopeSpanSchema = S.Struct({
  scope: S.optional(OtelScopeSchema),
  spans: S.Array(OtelSpanSchema),
});

export type OtelScopeSpan = typeof OtelScopeSpanSchema.Type;

export const OtelResourceSpanSchema = S.Struct({
  resource: S.optional(OtelResourceSchema),
  scopeSpans: S.Array(OtelScopeSpanSchema),
});

export type OtelResourceSpan = typeof OtelResourceSpanSchema.Type;

export const OtelTracesResultSchema = S.Struct({
  // Jaeger v3 omits `result` entirely when a search window matches no traces
  // (the body is a bare `{}`), so it must be optional.
  result: S.optional(
    S.Struct({
      resourceSpans: S.optional(S.Array(OtelResourceSpanSchema)),
    }),
  ),
});

export type OtelTracesResult = typeof OtelTracesResultSchema.Type;

export const OtelServicesResultSchema = S.Struct({
  services: S.Array(S.String),
});

export type OtelServicesResult = typeof OtelServicesResultSchema.Type;

export const OtelOperationSchema = S.Struct({
  name: S.String,
  spanKind: S.optional(S.String),
});

export type OtelOperation = typeof OtelOperationSchema.Type;

export const OtelOperationsResultSchema = S.Struct({
  operations: S.Array(OtelOperationSchema),
});

export type OtelOperationsResult = typeof OtelOperationsResultSchema.Type;

export const OtelTraceSummarySchema = S.Struct({
  traceId: S.String,
  // proto3 JSON omits empty and zero fields, so a trace without a root span has no root names.
  rootServiceName: S.optional(S.String),
  rootOperationName: S.optional(S.String),
  spanCount: S.optional(S.Number),
  errorSpanCount: S.optional(S.Number),
  services: S.optional(
    S.Array(
      S.Struct({
        name: S.String,
        spanCount: S.Number,
      }),
    ),
  ),
  minStartTimeUnixNano: S.Union([S.String, S.Number]),
  maxEndTimeUnixNano: S.Union([S.String, S.Number]),
});

export type OtelTraceSummary = typeof OtelTraceSummarySchema.Type;

export const OtelTraceSummariesResultSchema = S.Struct({
  summaries: S.optional(S.Array(OtelTraceSummarySchema)),
});

export type OtelTraceSummariesResult =
  typeof OtelTraceSummariesResultSchema.Type;

// Jaeger's legacy `/api/traces` (the UI's API). The v3 HTTP gateway has no
// attribute filter, so tag searches go through this one.
export const JaegerLegacyTagSchema = S.Struct({
  key: S.String,
  value: S.Unknown,
});

export type JaegerLegacyTag = typeof JaegerLegacyTagSchema.Type;

export const JaegerLegacySpanSchema = S.Struct({
  traceID: S.String,
  spanID: S.String,
  operationName: S.String,
  references: S.optional(
    S.Array(S.Struct({ refType: S.String, spanID: S.String })),
  ),
  // Microseconds since the epoch.
  startTime: S.Number,
  duration: S.Number,
  tags: S.optional(S.Array(JaegerLegacyTagSchema)),
  processID: S.String,
});

export type JaegerLegacySpan = typeof JaegerLegacySpanSchema.Type;

export const JaegerLegacyTraceSchema = S.Struct({
  traceID: S.String,
  spans: S.Array(JaegerLegacySpanSchema),
  processes: S.Record(S.String, S.Struct({ serviceName: S.String })),
});

export type JaegerLegacyTrace = typeof JaegerLegacyTraceSchema.Type;

export const JaegerLegacyTracesResultSchema = S.Struct({
  data: S.Array(JaegerLegacyTraceSchema),
});

export type JaegerLegacyTracesResult =
  typeof JaegerLegacyTracesResultSchema.Type;
