import { Config, Effect, Layer, Ref, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import type { TraceQuery } from './backend.js';
import { TraceBackend } from './backend.js';
import {
  JaegerBadResponse,
  JaegerUnreachable,
  TraceBackendUnauthorized,
  TraceNotFound,
} from './errors.js';
import {
  type JaegerLegacySpan,
  type JaegerLegacyTrace,
  JaegerLegacyTracesResultSchema,
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
  if (query.limit !== undefined) {
    params.append('query.num_traces', query.limit.toString());
  }
  return params;
}

// Not in buildSearchParams: the v3 gateway ignores `query.attributes`
// (jaeger v2.15.0 sets it to an empty map), so a tag search goes through the
// legacy API, which takes the window in epoch microseconds.
export function buildLegacySearchParams(query: TraceQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.append('service', query.service);
  if (query.operation !== undefined) {
    params.append('operation', query.operation);
  }
  params.append('start', String(Date.parse(query.startTimeMin) * 1000));
  params.append('end', String(Date.parse(query.startTimeMax) * 1000));
  if (query.minDuration !== undefined) {
    params.append('minDuration', query.minDuration);
  }
  if (query.maxDuration !== undefined) {
    params.append('maxDuration', query.maxDuration);
  }
  if (query.attributes !== undefined) {
    params.append('tags', JSON.stringify(query.attributes));
  }
  if (query.limit !== undefined) {
    params.append('limit', query.limit.toString());
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

// Jaeger sets `error=true` on error spans; OTel ingestion also keeps the
// status as `otel.status_code`.
const isLegacyErrorSpan = (span: JaegerLegacySpan): boolean =>
  (span.tags ?? []).some(
    (tag) =>
      (tag.key === 'error' && (tag.value === true || tag.value === 'true')) ||
      (tag.key === 'otel.status_code' && tag.value === 'ERROR'),
  );

export function mapLegacyTrace(trace: JaegerLegacyTrace): TraceSummary {
  const serviceOf = (span: JaegerLegacySpan) => {
    const process = trace.processes[span.processID];
    if (process === undefined) {
      throw new Error(
        `legacy trace ${trace.traceID}: span ${span.spanID} references unknown process ${span.processID}`,
      );
    }
    return process.serviceName;
  };
  const root = trace.spans.find((span) => (span.references ?? []).length === 0);

  const serviceMap: Map<string, number> = new Map();
  let errorSpanCount = 0;
  let minStartMicros = Number.POSITIVE_INFINITY;
  let maxEndMicros = Number.NEGATIVE_INFINITY;
  for (const span of trace.spans) {
    const serviceName = serviceOf(span);
    serviceMap.set(serviceName, (serviceMap.get(serviceName) ?? 0) + 1);
    if (isLegacyErrorSpan(span)) errorSpanCount += 1;
    minStartMicros = Math.min(minStartMicros, span.startTime);
    maxEndMicros = Math.max(maxEndMicros, span.startTime + span.duration);
  }

  return {
    traceId: trace.traceID,
    rootService: root !== undefined ? serviceOf(root) : 'unknown',
    rootOperation: root !== undefined ? root.operationName : 'unknown',
    spanCount: trace.spans.length,
    errorSpanCount,
    services: Array.from(serviceMap.entries()).map(([name, spanCount]) => ({
      name,
      spanCount,
    })),
    startTimeUnixNano: (BigInt(minStartMicros) * 1000n).toString(),
    durationMs: Math.floor((maxEndMicros - minStartMicros) / 1000),
  };
}

export interface JaegerResponse {
  readonly status: number;
  readonly contentType?: string;
  readonly body: string;
}

const BODY_SNIPPET_LENGTH = 120;

export const bodySnippet = (body: string): string =>
  body.replace(/\s+/g, ' ').trim().slice(0, BODY_SNIPPET_LENGTH);

/** Never takes the request: the error must not carry request headers. */
export const badResponse = (
  response: JaegerResponse,
  cause: unknown,
): JaegerBadResponse =>
  new JaegerBadResponse({
    cause,
    status: response.status,
    contentType: response.contentType,
    body: bodySnippet(response.body),
  });

export function parseJson(
  response: JaegerResponse,
): Effect.Effect<unknown, JaegerBadResponse, never> {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    response.body,
  ).pipe(Effect.mapError((cause) => badResponse(response, cause)));
}

export function validate<A>(
  schema: Schema.Decoder<A>,
  data: unknown,
  response: JaegerResponse,
): Effect.Effect<A, JaegerBadResponse, never> {
  return Schema.decodeUnknownEffect(schema)(data).pipe(
    Effect.mapError((cause) => badResponse(response, cause)),
  );
}

export interface JaegerBackendOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

// URL(path, base) would drop the base's path prefix (e.g. a reverse proxy
// mounted at /~/jaeger), so the path is appended to it manually.
export function joinUrl(base: URL, path: string): URL {
  const url = new URL(base);
  url.pathname = `${base.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  url.search = '';
  url.hash = '';
  return url;
}

function makeBackend(
  client: HttpClient.HttpClient,
  baseURL: URL,
  headers: Readonly<Record<string, string>>,
  summariesAvailable: Ref.Ref<boolean>,
): TraceBackend {
  const makeRequest = (
    path: string,
    params?: URLSearchParams,
  ): Effect.Effect<
    JaegerResponse,
    JaegerUnreachable | TraceBackendUnauthorized,
    never
  > => {
    const url = joinUrl(baseURL, path);
    if (params !== undefined) {
      url.search = params.toString();
    }
    return client.get(url.toString(), { headers }).pipe(
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
          Effect.flatMap((body) =>
            response.status === 401 || response.status === 403
              ? Effect.fail(
                  new TraceBackendUnauthorized({
                    status: response.status,
                    url: url.toString(),
                  }),
                )
              : Effect.succeed({
                  status: response.status,
                  contentType: response.headers['content-type'],
                  body,
                }),
          ),
        ),
      ),
    );
  };

  const listServices = Effect.gen(function* () {
    const response = yield* makeRequest('/api/v3/services');
    const parsed = yield* parseJson(response);
    const validated = yield* validate(
      OtelServicesResultSchema,
      parsed,
      response,
    );
    return validated.services;
  });

  const listOperations = (
    service: string,
  ): Effect.Effect<
    ReadonlyArray<string>,
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  > => {
    return Effect.gen(function* () {
      const params = new URLSearchParams();
      params.append('service', service);
      const response = yield* makeRequest('/api/v3/operations', params);
      const parsed = yield* parseJson(response);
      const validated = yield* validate(
        OtelOperationsResultSchema,
        parsed,
        response,
      );
      return validated.operations.map((op) => op.name);
    });
  };

  const getTrace = (
    traceId: string,
  ): Effect.Effect<
    Trace,
    | JaegerUnreachable
    | JaegerBadResponse
    | TraceNotFound
    | TraceBackendUnauthorized,
    never
  > => {
    return Effect.gen(function* () {
      const response = yield* makeRequest(
        `/api/v3/traces/${encodeURIComponent(traceId)}`,
      );
      if (response.status === 404 || response.status === 400) {
        return yield* Effect.fail(new TraceNotFound({ traceId }));
      }
      const parsed = yield* parseJson(response);
      const validated = yield* validate(
        OtelTracesResultSchema,
        parsed,
        response,
      );
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
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  > => {
    return Effect.gen(function* () {
      const params = buildSearchParams(query);
      const response = yield* makeRequest('/api/v3/trace-summaries', params);
      if (response.status < 200 || response.status >= 300) {
        // Jaeger's error bodies decode as an empty summaries result, so a non-2xx must fail here
        return yield* badResponse(
          response,
          new Error(`trace-summaries returned HTTP ${response.status}`),
        );
      }
      const parsed = yield* parseJson(response);
      const validated = yield* validate(
        OtelTraceSummariesResultSchema,
        parsed,
        response,
      );
      const summaries = validated.summaries ?? [];
      return summaries.map(mapTraceSummary);
    });
  };

  const searchTracesViaFullTraces = (
    query: TraceQuery,
  ): Effect.Effect<
    ReadonlyArray<TraceSummary>,
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  > => {
    return Effect.gen(function* () {
      const params = buildSearchParams(query);
      const response = yield* makeRequest('/api/v3/traces', params);
      if (response.status < 200 || response.status >= 300) {
        // Jaeger's error bodies decode as an empty result, so a non-2xx must fail here
        return yield* badResponse(
          response,
          new Error(`traces returned HTTP ${response.status}`),
        );
      }
      const parsed = yield* parseJson(response);
      const validated = yield* validate(
        OtelTracesResultSchema,
        parsed,
        response,
      );
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

  const searchTracesViaLegacy = (
    query: TraceQuery,
  ): Effect.Effect<
    ReadonlyArray<TraceSummary>,
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  > => {
    return Effect.gen(function* () {
      const response = yield* makeRequest(
        '/api/traces',
        buildLegacySearchParams(query),
      );
      if (response.status !== 200) {
        return yield* Effect.fail(
          badResponse(
            response,
            new Error(`legacy trace search answered ${response.status}`),
          ),
        );
      }
      const parsed = yield* parseJson(response);
      const validated = yield* validate(
        JaegerLegacyTracesResultSchema,
        parsed,
        response,
      );
      return yield* Effect.try({
        try: () => validated.data.map(mapLegacyTrace),
        catch: (cause) => badResponse(response, cause),
      });
    });
  };

  const searchTraces = (
    query: TraceQuery,
  ): Effect.Effect<
    ReadonlyArray<TraceSummary>,
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  > => {
    return Effect.gen(function* () {
      if (query.attributes !== undefined) {
        return yield* searchTracesViaLegacy(query);
      }
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

export const makeJaegerBackend = (
  options: JaegerBackendOptions,
): Effect.Effect<TraceBackend, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const summariesAvailable = yield* Ref.make(true);
    return makeBackend(
      client,
      new URL(options.url),
      options.headers,
      summariesAvailable,
    );
  });

export const JaegerBackendLayer = Layer.effect(
  TraceBackend,
  Effect.gen(function* () {
    const jaegerUrl = yield* Config.String('JAEGER_URL').pipe(
      Config.withDefault('http://localhost:16686'),
    );
    return yield* makeJaegerBackend({ url: jaegerUrl, headers: {} });
  }),
);
