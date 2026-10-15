import { Effect, Option } from 'effect';
import type { TraceBackend } from '../backend.js';
import {
  fingerprintFromErrorSpan,
  fingerprintFromException,
} from '../issues/fingerprint.js';
import { byFrequency, type ErrorGroup } from '../logs/errors-group.js';
import type { PageResume } from '../logs/paging.js';
import type { Span, Trace } from '../model.js';
import { extractExceptionInfo, nanoToIso } from '../normalize.js';
import { pageTraces, scanErrorTraces, traceFetchSize } from './paging.js';

const SAMPLE_TRACES = 3;
const FETCH_CONCURRENCY = 4;

interface Occurrence {
  readonly fingerprint: string;
  readonly sample: string;
  readonly ts: string;
  readonly traceId: string;
}

/** Same rules as the issue ingester: an exception event is one occurrence each; an error span without one is a single occurrence. */
const occurrencesOf = (span: Span): ReadonlyArray<Occurrence> => {
  const service = span.resource.serviceName;
  const base = { ts: nanoToIso(span.startTimeUnixNano), traceId: span.traceId };
  const exceptions = extractExceptionInfo(span.events);
  if (exceptions.length === 0) {
    const message = span.status.message;
    return [
      {
        ...base,
        fingerprint: fingerprintFromErrorSpan(span),
        sample: message === undefined || message === '' ? span.name : message,
      },
    ];
  }
  return exceptions.map((exception) => ({
    ...base,
    fingerprint: fingerprintFromException(service, exception),
    sample:
      exception.type === ''
        ? exception.message
        : `${exception.type}: ${exception.message}`,
  }));
};

/** Error spans of `otelService` only: a trace also holds other services' spans, which their own scan counts. */
export const groupTraceErrors = (
  traces: ReadonlyArray<Trace>,
  scope: { readonly service: string; readonly otelService: string },
): ReadonlyArray<ErrorGroup> => {
  const groups = new Map<
    string,
    {
      fingerprint: string;
      count: number;
      firstSeen: string;
      lastSeen: string;
      sample: string;
      traceIds: Array<string>;
    }
  >();
  for (const trace of traces) {
    for (const span of trace.spans) {
      if (
        span.status.code !== 'error' ||
        span.resource.serviceName !== scope.otelService
      ) {
        continue;
      }
      for (const occurrence of occurrencesOf(span)) {
        const group = groups.get(occurrence.fingerprint);
        if (group === undefined) {
          groups.set(occurrence.fingerprint, {
            fingerprint: occurrence.fingerprint,
            count: 1,
            firstSeen: occurrence.ts,
            lastSeen: occurrence.ts,
            sample: occurrence.sample,
            traceIds: [occurrence.traceId],
          });
          continue;
        }
        group.count += 1;
        if (occurrence.ts < group.firstSeen) group.firstSeen = occurrence.ts;
        if (occurrence.ts > group.lastSeen) group.lastSeen = occurrence.ts;
        if (
          group.traceIds.length < SAMPLE_TRACES &&
          !group.traceIds.includes(occurrence.traceId)
        ) {
          group.traceIds.push(occurrence.traceId);
        }
      }
    }
  }
  return [...groups.values()]
    .map(
      (group): ErrorGroup => ({
        source: 'traces',
        fingerprint: group.fingerprint,
        service: scope.service,
        count: group.count,
        firstSeen: group.firstSeen,
        lastSeen: group.lastSeen,
        deploymentIds: [],
        sample: group.sample,
        traceId: group.traceIds[0],
        traceIds: group.traceIds,
      }),
    )
    .sort(byFrequency);
};

/** Services share traces, so scans of several services through one memo read each trace once. */
export const memoizeGetTrace = (
  backend: TraceBackend,
): TraceBackend['getTrace'] => {
  const memo = new Map<string, ReturnType<TraceBackend['getTrace']>>();
  return (traceId) =>
    Effect.gen(function* () {
      const known = memo.get(traceId);
      if (known !== undefined) return yield* known;
      const cached = yield* Effect.cached(backend.getTrace(traceId));
      memo.set(traceId, cached);
      return yield* cached;
    });
};

export interface TraceErrorScanResult {
  readonly groups: ReadonlyArray<ErrorGroup>;
  /** Traces with error spans that were fetched and counted. */
  readonly errorTraces: number;
  /** Traces read from the search to find them. */
  readonly scanned: number;
  /** True when older error traces were left unread (either cap), so counts undercount. */
  readonly partial: boolean;
}

/**
 * Pages the window newest to oldest like `spans --errors`, fetches the full
 * trace of up to `maxErrorTraces` of the ones with error spans, and groups
 * their error spans with the issue fingerprints. Error counts come from the
 * summaries, never from Jaeger's error-tag search (unreliable).
 */
export const scanTraceErrors = (input: {
  readonly backend: TraceBackend;
  readonly getTrace?: TraceBackend['getTrace'];
  readonly service: string;
  readonly otelService: string;
  readonly since: Date;
  readonly until: Date;
  readonly maxErrorTraces: number;
  readonly scanCap: number;
  readonly pageSize: number;
}) =>
  Effect.gen(function* () {
    const getTrace = input.getTrace ?? input.backend.getTrace;
    const scan = yield* scanErrorTraces({
      limit: input.maxErrorTraces,
      scanCap: input.scanCap,
      pageSize: input.pageSize,
      fetchPage: (request: {
        readonly resume?: PageResume;
        readonly size: number;
      }) =>
        input.backend
          .searchTraces({
            service: input.otelService,
            startTimeMin: input.since.toISOString(),
            startTimeMax: request.resume?.before ?? input.until.toISOString(),
            limit: traceFetchSize(request.size, request.resume),
          })
          .pipe(
            Effect.map((summaries) =>
              pageTraces({
                summaries,
                limit: request.size,
                resume: request.resume,
              }),
            ),
          ),
    });
    // Newest first, so the sample trace ids are the most recent ones.
    const fetched = yield* Effect.forEach(
      [...scan.matches].reverse(),
      (summary) =>
        getTrace(summary.traceId).pipe(
          Effect.map(Option.some),
          // Expired between the search and the fetch; the ingester skips these too.
          Effect.catchTag('TraceNotFound', () => Effect.succeed(Option.none())),
        ),
      { concurrency: FETCH_CONCURRENCY },
    );
    const traces = fetched.flatMap((trace) =>
      Option.isSome(trace) ? [trace.value] : [],
    );
    return {
      groups: groupTraceErrors(traces, input),
      errorTraces: traces.length,
      scanned: scan.scanned,
      partial: scan.next !== undefined,
    } satisfies TraceErrorScanResult;
  });
