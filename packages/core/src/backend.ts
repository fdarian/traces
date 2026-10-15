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
  readonly attributes?: Record<string, string>;
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
