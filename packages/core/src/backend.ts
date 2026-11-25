import { Context, type Effect, type Option } from 'effect';
import type {
  JaegerBadResponse,
  JaegerUnreachable,
  TraceBackendUnauthorized,
  TraceNotFound,
} from './errors.js';
import type { Trace, TraceSummary } from './model.js';

export interface TraceQuery {
  readonly service: string;
  readonly operation?: string;
  readonly startTimeMin: string;
  readonly startTimeMax: string;
  readonly minDuration?: string;
  readonly maxDuration?: string;
  /** Traces where each attribute is set to exactly this string on some span (or its resource). */
  readonly attributes?: Record<string, string>;
  /** A hint to ask the server for error traces only; a backend that cannot filter ignores it, so callers still check `errorSpanCount`. */
  readonly errorsOnly?: boolean;
  readonly limit?: number;
}

export interface TraceBackend {
  readonly listServices: Effect.Effect<
    ReadonlyArray<string>,
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  >;
  readonly listOperations: (
    service: string,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  >;
  readonly searchTraces: (
    query: TraceQuery,
  ) => Effect.Effect<
    ReadonlyArray<TraceSummary>,
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  >;
  /**
   * The newest `query.limit` traces of the window, with their spans, in one
   * request. Attributes and `errorsOnly` are not applied: the caller matches
   * them on the traces itself (see `attributePage`), so it can tell when its
   * scan was cut short.
   */
  readonly searchFullTraces: (
    query: TraceQuery,
  ) => Effect.Effect<
    ReadonlyArray<Trace>,
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  >;
  /**
   * A tag search the server evaluates (`attributes`, and `errorsOnly` as the
   * `error` tag). None when the server cannot: Jaeger v2's v3 gateway ignores
   * tags and a host may serve no other API.
   */
  readonly searchTagged: (
    query: TraceQuery,
  ) => Effect.Effect<
    Option.Option<ReadonlyArray<TraceSummary>>,
    JaegerUnreachable | JaegerBadResponse | TraceBackendUnauthorized,
    never
  >;
  readonly getTrace: (
    traceId: string,
  ) => Effect.Effect<
    Trace,
    | JaegerUnreachable
    | JaegerBadResponse
    | TraceNotFound
    | TraceBackendUnauthorized,
    never
  >;
}

export const TraceBackend = Context.Service<TraceBackend>(
  'traces/TraceBackend',
);
