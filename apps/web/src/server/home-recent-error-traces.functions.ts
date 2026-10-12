import { createServerFn } from '@tanstack/react-start';
import { TraceBackend, type TraceSummary } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const HomeRecentErrorTracesInputSchema = S.Struct({
  service: S.String,
  startTimeMin: S.String,
  startTimeMax: S.String,
  limit: S.optional(S.Number),
});

export type SerializableTraceSummary = {
  readonly traceId: string;
  readonly rootService: string;
  readonly rootOperation: string;
  readonly spanCount: number;
  readonly errorSpanCount: number | undefined;
  readonly durationMs: number;
  readonly startTimeUnixNano: string;
};

function serializeTraceSummary(trace: TraceSummary): SerializableTraceSummary {
  return {
    traceId: trace.traceId,
    rootService: trace.rootService,
    rootOperation: trace.rootOperation,
    spanCount: trace.spanCount,
    errorSpanCount: trace.errorSpanCount,
    durationMs: trace.durationMs,
    startTimeUnixNano: trace.startTimeUnixNano,
  };
}

export const homeRecentErrorTraces = createServerFn({ method: 'GET' })
  .validator(S.toStandardSchemaV1(HomeRecentErrorTracesInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const limit = data.limit ?? 50;

    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      const traces = yield* backend.searchTraces({
        service: data.service,
        startTimeMin: data.startTimeMin,
        startTimeMax: data.startTimeMax,
        limit,
      });

      const errorTraces = traces.filter(
        (t) => t.errorSpanCount !== undefined && t.errorSpanCount > 0,
      );

      return errorTraces.slice(0, 6).map(serializeTraceSummary);
    });

    return RuntimeServer.runPromise(effect);
  });
