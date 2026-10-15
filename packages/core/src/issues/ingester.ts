import { Config, Effect, Fiber, Layer, Ref, Schedule } from 'effect';
import { TraceBackend } from '../backend.js';
import type {
  JaegerBadResponse,
  JaegerUnreachable,
  TraceBackendUnauthorized,
} from '../errors.js';
import type { Span } from '../model.js';
import { extractExceptionInfo } from '../normalize.js';
import { serializeAttribute } from '../serialize.js';
import type { IssueStoreError } from './errors.js';
import {
  buildIssueTitle,
  fingerprintFromErrorSpan,
  fingerprintFromException,
} from './fingerprint.js';
import { computeIngestCursorEnd } from './ingest-cursor.js';
import { IssueStore } from './store.js';

const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_TRACE_LIMIT = 200;
const DEFAULT_OVERLAP_MS = 60000;
const DEFAULT_INITIAL_LOOKBACK_MS = 3600000;
const MIN_WINDOW_MS = 5000;

function toRfc3339(date: Date): string {
  return date.toISOString();
}

function spanAttributesRecord(span: Span): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of span.attributes) {
    const serialized = serializeAttribute(attribute);
    if (serialized !== null) {
      result[serialized.key] = serialized.value;
    }
  }
  return result;
}

function spanTimestampMs(span: Span): number {
  const nanos = BigInt(span.startTimeUnixNano);
  return Number(nanos / BigInt(1000000));
}

const ingestService = (
  service: string,
  now: Date,
  traceLimit: number,
  overlapMs: number,
  initialLookbackMs: number,
  windowScaleRef: Ref.Ref<Map<string, number>>,
): Effect.Effect<
  void,
  | JaegerUnreachable
  | JaegerBadResponse
  | TraceBackendUnauthorized
  | IssueStoreError,
  TraceBackend | IssueStore
> => {
  return Effect.gen(function* () {
    const backend = yield* TraceBackend;
    const store = yield* IssueStore;

    const scaleMap = yield* Ref.get(windowScaleRef);
    const scale = scaleMap.get(service);
    const windowScale = scale === undefined ? 1 : scale;

    const cursor = yield* store.getIngestCursor(service);
    let windowStart: Date;
    if (cursor === null) {
      windowStart = new Date(now.getTime() - initialLookbackMs);
    } else {
      windowStart = new Date(cursor.getTime() - overlapMs);
    }

    const maxWindowMs = initialLookbackMs * windowScale;
    const requestedWindowMs = now.getTime() - windowStart.getTime();
    if (requestedWindowMs > maxWindowMs) {
      windowStart = new Date(now.getTime() - maxWindowMs);
    }

    if (windowStart.getTime() >= now.getTime()) {
      return;
    }

    const summaries = yield* backend.searchTraces({
      service,
      startTimeMin: toRfc3339(windowStart),
      startTimeMax: toRfc3339(now),
      limit: traceLimit,
    });

    if (summaries.length === traceLimit) {
      yield* Effect.logWarning(
        `ingester hit trace limit for service=${service}; shrinking next window`,
      );
      const nextScale = Math.max(
        windowScale * 0.5,
        MIN_WINDOW_MS / initialLookbackMs,
      );
      yield* Ref.update(windowScaleRef, (map) => {
        const next = new Map(map);
        next.set(service, nextScale);
        return next;
      });
    } else if (windowScale < 1) {
      yield* Ref.update(windowScaleRef, (map) => {
        const next = new Map(map);
        next.set(service, 1);
        return next;
      });
    }

    for (const summary of summaries) {
      const traceResult = yield* backend
        .getTrace(summary.traceId)
        .pipe(Effect.catchTag('TraceNotFound', () => Effect.succeed(null)));
      if (traceResult === null) {
        continue;
      }
      const trace = traceResult;
      for (const span of trace.spans) {
        if (span.status.code !== 'error') {
          continue;
        }

        const serviceName = span.resource.serviceName;
        const attributes = spanAttributesRecord(span);
        const exceptions = extractExceptionInfo(span.events);

        if (exceptions.length === 0) {
          const fingerprint = fingerprintFromErrorSpan(span);
          const exceptionType = 'ErrorSpan';
          const message =
            span.status.message !== undefined ? span.status.message : span.name;
          yield* store.upsertOccurrence({
            fingerprint,
            title: buildIssueTitle(exceptionType, message),
            service: serviceName,
            exceptionType,
            traceId: span.traceId,
            spanId: span.spanId,
            serviceName,
            timestamp: spanTimestampMs(span),
            exceptionMessage: message,
            attributes,
          });
          continue;
        }

        for (const exception of exceptions) {
          const fingerprint = fingerprintFromException(serviceName, exception);
          yield* store.upsertOccurrence({
            fingerprint,
            title: buildIssueTitle(exception.type, exception.message),
            service: serviceName,
            exceptionType: exception.type,
            traceId: span.traceId,
            spanId: span.spanId,
            serviceName,
            timestamp: spanTimestampMs(span),
            exceptionMessage: exception.message,
            exceptionStacktrace: exception.stacktrace,
            attributes,
          });
        }
      }
    }

    const cursorEnd = computeIngestCursorEnd(
      summaries,
      now,
      traceLimit,
      overlapMs,
      cursor,
    );
    yield* store.setIngestCursor(service, cursorEnd);
  });
};

const ingestTick = (
  traceLimit: number,
  overlapMs: number,
  initialLookbackMs: number,
  windowScaleRef: Ref.Ref<Map<string, number>>,
): Effect.Effect<
  void,
  | JaegerUnreachable
  | JaegerBadResponse
  | TraceBackendUnauthorized
  | IssueStoreError,
  TraceBackend | IssueStore
> => {
  return Effect.gen(function* () {
    const backend = yield* TraceBackend;
    const services = yield* backend.listServices;
    const now = new Date();

    for (const service of services) {
      yield* ingestService(
        service,
        now,
        traceLimit,
        overlapMs,
        initialLookbackMs,
        windowScaleRef,
      );
    }
  });
};

export const runIngestOnce = Effect.gen(function* () {
  const traceLimit = yield* Config.Number('INGEST_TRACE_LIMIT').pipe(
    Config.withDefault(DEFAULT_TRACE_LIMIT),
  );
  const overlapMs = yield* Config.Number('INGEST_OVERLAP_MS').pipe(
    Config.withDefault(DEFAULT_OVERLAP_MS),
  );
  const initialLookbackMs = yield* Config.Number(
    'INGEST_INITIAL_LOOKBACK_MS',
  ).pipe(Config.withDefault(DEFAULT_INITIAL_LOOKBACK_MS));
  const windowScaleRef = yield* Ref.make(new Map<string, number>());
  yield* ingestTick(traceLimit, overlapMs, initialLookbackMs, windowScaleRef);
});

export const runIngester = Effect.gen(function* () {
  const pollIntervalMs = yield* Config.Number('INGEST_POLL_INTERVAL_MS').pipe(
    Config.withDefault(DEFAULT_POLL_INTERVAL_MS),
  );
  const traceLimit = yield* Config.Number('INGEST_TRACE_LIMIT').pipe(
    Config.withDefault(DEFAULT_TRACE_LIMIT),
  );
  const overlapMs = yield* Config.Number('INGEST_OVERLAP_MS').pipe(
    Config.withDefault(DEFAULT_OVERLAP_MS),
  );
  const initialLookbackMs = yield* Config.Number(
    'INGEST_INITIAL_LOOKBACK_MS',
  ).pipe(Config.withDefault(DEFAULT_INITIAL_LOOKBACK_MS));

  const windowScaleRef = yield* Ref.make(new Map<string, number>());

  return ingestTick(
    traceLimit,
    overlapMs,
    initialLookbackMs,
    windowScaleRef,
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(`ingester tick failed: ${String(cause)}`),
    ),
    Effect.repeat(Schedule.spaced(pollIntervalMs)),
  );
});

export const IngesterLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const program = yield* runIngester;
    const fiber = yield* Effect.forkScoped(program);
    yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
  }),
);
