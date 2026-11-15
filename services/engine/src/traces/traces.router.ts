import { TraceBackend, TraceNotFound } from '@traces/core';
import { Effect } from 'effect';
import { mapJaegerErrors } from '#/rpc/errors';
import { os } from '#/rpc/implementer';
import { serializeTrace } from '#/traces/trace-serialize';

const listServices = os.traces.listServices.effect(function* ({ errors }) {
  const backend = yield* TraceBackend;
  return yield* backend.listServices.pipe(mapJaegerErrors(errors));
});

const listOperations = os.traces.listOperations.effect(function* ({
  input,
  errors,
}) {
  const backend = yield* TraceBackend;
  return yield* backend.listOperations(input).pipe(mapJaegerErrors(errors));
});

const search = os.traces.search.effect(function* ({ input, errors }) {
  const backend = yield* TraceBackend;
  return yield* backend.searchTraces(input).pipe(mapJaegerErrors(errors));
});

const get = os.traces.get.effect(function* ({ input, errors }) {
  const backend = yield* TraceBackend;
  const trace = yield* backend.getTrace(input.traceId).pipe(
    Effect.catchTag('TraceNotFound', (error: TraceNotFound) =>
      Effect.fail(errors.TRACE_NOT_FOUND({ data: { traceId: error.traceId } })),
    ),
    mapJaegerErrors(errors),
  );
  return serializeTrace(trace);
});

export const tracesRouter = { listServices, listOperations, search, get };
