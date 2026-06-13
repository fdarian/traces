import * as S from 'effect/Schema';

export const OtelAttributeValueSchema = S.Union(
  S.Struct({ stringValue: S.String }),
  S.Struct({ intValue: S.Union(S.String, S.Number) }),
  S.Struct({ boolValue: S.Boolean }),
  S.Struct({ doubleValue: S.Number }),
  S.Struct({ arrayValue: S.Unknown }),
  S.Struct({ kvlistValue: S.Unknown }),
);

export type OtelAttributeValue = typeof OtelAttributeValueSchema.Type;

export const OtelAttributeSchema = S.Struct({
  key: S.String,
  value: OtelAttributeValueSchema,
});

export type OtelAttribute = typeof OtelAttributeSchema.Type;

export const OtelEventSchema = S.Struct({
  timeUnixNano: S.Union(S.String, S.Number),
  name: S.String,
  attributes: S.optional(S.Array(OtelAttributeSchema)),
});

export type OtelEvent = typeof OtelEventSchema.Type;

export const OtelStatusSchema = S.Struct({
  code: S.optional(S.Union(S.String, S.Number)),
  message: S.optional(S.String),
});

export type OtelStatus = typeof OtelStatusSchema.Type;

export const OtelSpanSchema = S.Struct({
  traceId: S.String,
  spanId: S.String,
  parentSpanId: S.optional(S.String),
  name: S.String,
  kind: S.optional(S.Union(S.String, S.Number)),
  startTimeUnixNano: S.Union(S.String, S.Number),
  endTimeUnixNano: S.Union(S.String, S.Number),
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
  rootServiceName: S.String,
  rootOperationName: S.String,
  spanCount: S.Number,
  errorSpanCount: S.optional(S.Number),
  services: S.Array(
    S.Struct({
      name: S.String,
      spanCount: S.Number,
    }),
  ),
  minStartTimeUnixNano: S.Union(S.String, S.Number),
  maxEndTimeUnixNano: S.Union(S.String, S.Number),
});

export type OtelTraceSummary = typeof OtelTraceSummarySchema.Type;

export const OtelTraceSummariesResultSchema = S.Struct({
  summaries: S.optional(S.Array(OtelTraceSummarySchema)),
});

export type OtelTraceSummariesResult =
  typeof OtelTraceSummariesResultSchema.Type;
