import { Context, type Effect } from 'effect';
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
