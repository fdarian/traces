import * as v from 'valibot';

export const OtelAttributeValueSchema = v.union([
  v.object({ stringValue: v.string() }),
  v.object({ intValue: v.union([v.string(), v.number()]) }),
  v.object({ boolValue: v.boolean() }),
  v.object({ doubleValue: v.number() }),
  v.object({ arrayValue: v.any() }),
  v.object({ kvlistValue: v.any() }),
]);

export type OtelAttributeValue = v.InferOutput<typeof OtelAttributeValueSchema>;

export const OtelAttributeSchema = v.object({
  key: v.string(),
  value: OtelAttributeValueSchema,
});

export type OtelAttribute = v.InferOutput<typeof OtelAttributeSchema>;

export const OtelEventSchema = v.object({
  timeUnixNano: v.union([v.string(), v.number()]),
  name: v.string(),
  attributes: v.optional(v.array(OtelAttributeSchema)),
});

export type OtelEvent = v.InferOutput<typeof OtelEventSchema>;

export const OtelStatusSchema = v.object({
  code: v.optional(v.union([v.string(), v.number()])),
  message: v.optional(v.string()),
});

export type OtelStatus = v.InferOutput<typeof OtelStatusSchema>;

export const OtelSpanSchema = v.object({
  traceId: v.string(),
  spanId: v.string(),
  parentSpanId: v.optional(v.string()),
  name: v.string(),
  kind: v.optional(v.union([v.string(), v.number()])),
  startTimeUnixNano: v.union([v.string(), v.number()]),
  endTimeUnixNano: v.union([v.string(), v.number()]),
  attributes: v.optional(v.array(OtelAttributeSchema)),
  events: v.optional(v.array(OtelEventSchema)),
  status: v.optional(OtelStatusSchema),
});

export type OtelSpan = v.InferOutput<typeof OtelSpanSchema>;

export const OtelResourceSchema = v.object({
  attributes: v.optional(v.array(OtelAttributeSchema)),
});

export type OtelResource = v.InferOutput<typeof OtelResourceSchema>;

export const OtelScopeSchema = v.object({
  name: v.optional(v.string()),
  version: v.optional(v.string()),
});

export type OtelScope = v.InferOutput<typeof OtelScopeSchema>;

export const OtelScopeSpanSchema = v.object({
  scope: v.optional(OtelScopeSchema),
  spans: v.array(OtelSpanSchema),
});

export type OtelScopeSpan = v.InferOutput<typeof OtelScopeSpanSchema>;

export const OtelResourceSpanSchema = v.object({
  resource: v.optional(OtelResourceSchema),
  scopeSpans: v.array(OtelScopeSpanSchema),
});

export type OtelResourceSpan = v.InferOutput<typeof OtelResourceSpanSchema>;

export const OtelTracesResultSchema = v.object({
  result: v.object({
    resourceSpans: v.optional(v.array(OtelResourceSpanSchema)),
  }),
});

export type OtelTracesResult = v.InferOutput<typeof OtelTracesResultSchema>;

export const OtelServicesResultSchema = v.object({
  services: v.array(v.string()),
});

export type OtelServicesResult = v.InferOutput<typeof OtelServicesResultSchema>;

export const OtelOperationSchema = v.object({
  name: v.string(),
  spanKind: v.optional(v.string()),
});

export type OtelOperation = v.InferOutput<typeof OtelOperationSchema>;

export const OtelOperationsResultSchema = v.object({
  operations: v.array(OtelOperationSchema),
});

export type OtelOperationsResult = v.InferOutput<
  typeof OtelOperationsResultSchema
>;

export const OtelTraceSummarySchema = v.object({
  traceId: v.string(),
  rootServiceName: v.string(),
  rootOperationName: v.string(),
  spanCount: v.number(),
  errorSpanCount: v.optional(v.number()),
  services: v.array(
    v.object({
      name: v.string(),
      spanCount: v.number(),
    }),
  ),
  minStartTimeUnixNano: v.union([v.string(), v.number()]),
  maxEndTimeUnixNano: v.union([v.string(), v.number()]),
});

export type OtelTraceSummary = v.InferOutput<typeof OtelTraceSummarySchema>;

export const OtelTraceSummariesResultSchema = v.object({
  summaries: v.optional(v.array(OtelTraceSummarySchema)),
});

export type OtelTraceSummariesResult = v.InferOutput<
  typeof OtelTraceSummariesResultSchema
>;
