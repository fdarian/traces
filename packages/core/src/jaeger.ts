import { Config, Effect, Layer, Ref, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import type { TraceQuery } from './backend.js';
import { TraceBackend } from './backend.js';
import {
  JaegerBadResponse,
  JaegerUnreachable,
  TraceNotFound,
} from './errors.js';
import {
  OtelOperationsResultSchema,
  type OtelResourceSpan,
  OtelServicesResultSchema,
  type OtelSpan,
  OtelTraceSummariesResultSchema,
  type OtelTraceSummary,
  OtelTracesResultSchema,
} from './jaeger-schema.js';
import type {
  Span,
  SpanEvent,
  SpanResource,
  SpanStatus,
  Trace,
  TraceSummary,
} from './model.js';
import {
  nanosToMs,
  normalizeAttributes,
  normalizeDurationMs,
  normalizeSpanEvents,
  normalizeStatusCode,
  normalizeTimestamp,
} from './normalize.js';

export function buildSearchParams(query: TraceQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.append('query.service_name', query.service);
  if (query.operation !== undefined) {
    params.append('query.operation_name', query.operation);
  }
  params.append('query.start_time_min', query.startTimeMin);
  params.append('query.start_time_max', query.startTimeMax);
  if (query.minDuration !== undefined) {
    params.append('query.duration_min', query.minDuration);
  }
  if (query.maxDuration !== undefined) {
    params.append('query.duration_max', query.maxDuration);
  }
  if (query.attributes !== undefined) {
    params.append('query.attributes', JSON.stringify(query.attributes));
  }
  if (query.limit !== undefined) {
    params.append('query.num_traces', query.limit.toString());
  }
  return params;
}

export function mapResource(
  resource: OtelResourceSpan['resource'],
): SpanResource {
  const attributes = normalizeAttributes(resource?.attributes);
  const serviceNameAttr = attributes.find((a) => a.key === 'service.name');
  const serviceName =
    serviceNameAttr !== undefined ? String(serviceNameAttr.value) : 'unknown';
  return { serviceName, attributes };
}

export function mapSpan(rawSpan: OtelSpan, resource: SpanResource): Span {
  const status: SpanStatus = {
    code: normalizeStatusCode(rawSpan.status?.code),
    message: rawSpan.status?.message,
  };

  const startTimeUnixNano = normalizeTimestamp(rawSpan.startTimeUnixNano);
  const endTimeUnixNano = normalizeTimestamp(rawSpan.endTimeUnixNano);

  const events: ReadonlyArray<SpanEvent> = normalizeSpanEvents(rawSpan.events);

  return {
    traceId: rawSpan.traceId,
    spanId: rawSpan.spanId,
    parentSpanId: rawSpan.parentSpanId,
    name: rawSpan.name,
    kind: String(rawSpan.kind ?? 'internal'),
    startTimeUnixNano,
    endTimeUnixNano,
    durationMs: normalizeDurationMs(startTimeUnixNano, endTimeUnixNano),
    status,
    attributes: normalizeAttributes(rawSpan.attributes),
    events,
    resource,
  };
}

export function mapTrace(
  resourceSpans: ReadonlyArray<OtelResourceSpan>,
): Trace {
  const spans: Array<Span> = [];
  let traceId = '';
  for (const resourceSpan of resourceSpans) {
    const resource = mapResource(resourceSpan.resource);
    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const rawSpan of scopeSpan.spans) {
        if (traceId === '') {
          traceId = rawSpan.traceId;
        }
        spans.push(mapSpan(rawSpan, resource));
      }
    }
  }
  return { traceId, spans };
}

export function computeTraceSummary(trace: Trace): TraceSummary {
  const rootSpan = trace.spans.find((s) => s.parentSpanId === undefined);
  const rootService =
    rootSpan !== undefined ? rootSpan.resource.serviceName : 'unknown';
  const rootOperation = rootSpan !== undefined ? rootSpan.name : 'unknown';

  const serviceMap: Map<string, number> = new Map();
  let errorSpanCount = 0;
  let minStart = BigInt('0');
  let maxEnd = BigInt('0');
  let first = true;

  for (const span of trace.spans) {
    const serviceName = span.resource.serviceName;
    serviceMap.set(serviceName, (serviceMap.get(serviceName) ?? 0) + 1);
    if (span.status.code === 'error') {
      errorSpanCount += 1;
    }
    const start = BigInt(span.startTimeUnixNano);
    const end = BigInt(span.endTimeUnixNano);
    if (first) {
      minStart = start;
      maxEnd = end;
      first = false;
    } else {
      if (start < minStart) {
        minStart = start;
      }
      if (end > maxEnd) {
        maxEnd = end;
      }
    }
  }

  const services = Array.from(serviceMap.entries()).map(
    ([name, spanCount]) => ({ name, spanCount }),
  );

  const durationMs = nanosToMs(maxEnd - minStart);

  return {
    traceId: trace.traceId,
    rootService,
    rootOperation,
    spanCount: trace.spans.length,
    errorSpanCount,
    services,
    startTimeUnixNano: minStart.toString(),
    durationMs,
  };
}

export function mapTraceSummary(raw: OtelTraceSummary): TraceSummary {
  const startTimeUnixNano = normalizeTimestamp(raw.minStartTimeUnixNano);
  const endTimeUnixNano = normalizeTimestamp(raw.maxEndTimeUnixNano);
  const durationMs = normalizeDurationMs(startTimeUnixNano, endTimeUnixNano);

  return {
    traceId: raw.traceId,
    rootService: raw.rootServiceName,
    rootOperation: raw.rootOperationName,
    spanCount: raw.spanCount,
    errorSpanCount: raw.errorSpanCount,
    services: raw.services.map((s) => ({
      name: s.name,
      spanCount: s.spanCount,
    })),
    startTimeUnixNano,
    durationMs,
  };
}

export function parseJson(
  body: string,
): Effect.Effect<unknown, JaegerBadResponse, never> {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    body,
  ).pipe(Effect.mapError((cause) => new JaegerBadResponse({ cause })));
}

export function validate<A>(
  schema: Schema.Decoder<A>,
  data: unknown,
): Effect.Effect<A, JaegerBadResponse, never> {
  return Schema.decodeUnknownEffect(schema)(data).pipe(
    Effect.mapError((cause) => new JaegerBadResponse({ cause })),
  );
}

function makeBackend(
  client: HttpClient.HttpClient,
  baseURL: URL,
  summariesAvailable: Ref.Ref<boolean>,
) {
  const makeRequest = (
    path: string,
    params?: URLSearchParams,
  ): Effect.Effect<
    { readonly status: number; readonly body: string },
    JaegerUnreachable,
    never
  > => {
    const url = new URL(path, baseURL);
    if (params !== undefined) {
      url.search = params.toString();
    }
    return client.get(url.toString()).pipe(
      Effect.mapError(
        (cause) =>
          new JaegerUnreachable({
            cause,
          }),
      ),
      Effect.flatMap((response) =>
        response.text.pipe(
          Effect.mapError(
            (cause) =>
              new JaegerUnreachable({
                cause,
              }),
          ),
          Effect.map((body) => ({ status: response.status, body })),
        ),
      ),
    );
  };

  const listServices = Effect.gen(function* () {
    const response = yield* makeRequest('/api/v3/services');
    const parsed = yield* parseJson(response.body);
    const validated = yield* validate(OtelServicesResultSchema, parsed);
    return validated.services;
  });

  const listOperations = (
    service: string,
  ): Effect.Effect<
    ReadonlyArray<string>,
    JaegerUnreachable | JaegerBadResponse,
    never
  > => {
    return Effect.gen(function* () {
      const params = new URLSearchParams();
      params.append('service', service);
      const response = yield* makeRequest('/api/v3/operations', params);
      const parsed = yield* parseJson(response.body);
      const validated = yield* validate(OtelOperationsResultSchema, parsed);
      return validated.operations.map((op) => op.name);
    });
  };

  const getTrace = (
    traceId: string,
  ): Effect.Effect<
    Trace,
    JaegerUnreachable | JaegerBadResponse | TraceNotFound,
    never
  > => {
    return Effect.gen(function* () {
      const response = yield* makeRequest(`/api/v3/traces/${traceId}`);
      if (response.status === 404 || response.status === 400) {
        return yield* Effect.fail(new TraceNotFound({ traceId }));
      }
      const parsed = yield* parseJson(response.body);
      const validated = yield* validate(OtelTracesResultSchema, parsed);
      const resourceSpans = validated.result?.resourceSpans ?? [];
      if (resourceSpans.length === 0) {
        return yield* Effect.fail(new TraceNotFound({ traceId }));
      }
      return mapTrace(resourceSpans);
    });
  };

  const searchTracesViaSummaries = (
    query: TraceQuery,
  ): Effect.Effect<
    ReadonlyArray<TraceSummary>,
    JaegerUnreachable | JaegerBadResponse,
    never
  > => {
    return Effect.gen(function* () {
      const params = buildSearchParams(query);
      const response = yield* makeRequest('/api/v3/trace-summaries', params);
      if (response.status < 200 || response.status >= 300) {
        // Jaeger's error bodies decode as an empty summaries result, so a non-2xx must fail here
        return yield* new JaegerBadResponse({
          cause: new Error(`trace-summaries returned HTTP ${response.status}`),
          status: response.status,
        });
      }
      const parsed = yield* parseJson(response.body);
      const validated = yield* validate(OtelTraceSummariesResultSchema, parsed);
      const summaries = validated.summaries ?? [];
      return summaries.map(mapTraceSummary);
    });
  };

  const searchTracesViaFullTraces = (
    query: TraceQuery,
  ): Effect.Effect<
    ReadonlyArray<TraceSummary>,
    JaegerUnreachable | JaegerBadResponse,
    never
  > => {
    return Effect.gen(function* () {
      const params = buildSearchParams(query);
      const response = yield* makeRequest('/api/v3/traces', params);
      if (response.status < 200 || response.status >= 300) {
        // Jaeger's error bodies decode as an empty result, so a non-2xx must fail here
        return yield* new JaegerBadResponse({
          cause: new Error(`traces returned HTTP ${response.status}`),
          status: response.status,
        });
      }
      const parsed = yield* parseJson(response.body);
      const validated = yield* validate(OtelTracesResultSchema, parsed);
      const resourceSpans = validated.result?.resourceSpans ?? [];

      const traceMap: Map<string, Array<OtelResourceSpan>> = new Map();
      for (const resourceSpan of resourceSpans) {
        for (const scopeSpan of resourceSpan.scopeSpans) {
          for (const span of scopeSpan.spans) {
            const existing = traceMap.get(span.traceId);
            if (existing === undefined) {
              traceMap.set(span.traceId, [resourceSpan]);
            } else {
              if (!existing.includes(resourceSpan)) {
                existing.push(resourceSpan);
              }
            }
          }
        }
      }

      const summaries: Array<TraceSummary> = [];
      for (const resourceSpans of traceMap.values()) {
        const trace = mapTrace(resourceSpans);
        summaries.push(computeTraceSummary(trace));
      }
      return summaries;
    });
  };

  const searchTraces = (
    query: TraceQuery,
  ): Effect.Effect<
    ReadonlyArray<TraceSummary>,
    JaegerUnreachable | JaegerBadResponse,
    never
  > => {
    return Effect.gen(function* () {
      const available = yield* Ref.get(summariesAvailable);
      if (!available) {
        return yield* searchTracesViaFullTraces(query);
      }

      const result = yield* searchTracesViaSummaries(query).pipe(
        Effect.catchTag('JaegerBadResponse', (error) =>
          Effect.gen(function* () {
            if (error.status !== 404) {
              return yield* error;
            }
            yield* Ref.set(summariesAvailable, false);
            return yield* searchTracesViaFullTraces(query);
          }),
        ),
      );

      return result;
    });
  };

  return {
    listServices,
    listOperations,
    searchTraces,
    getTrace,
  };
}

export const JaegerBackendLayer = Layer.effect(
  TraceBackend,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const jaegerUrl = yield* Config.String('JAEGER_URL').pipe(
      Config.withDefault('http://localhost:16686'),
    );
    const baseURL = new URL(jaegerUrl);
    const summariesAvailable = yield* Ref.make(true);
    return makeBackend(client, baseURL, summariesAvailable);
  }),
);
