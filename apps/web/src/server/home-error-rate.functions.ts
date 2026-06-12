import { createServerFn } from '@tanstack/react-start';
import { TraceBackend } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const HomeErrorRateInputSchema = S.Struct({
  service: S.String,
  startTimeMin: S.String,
  startTimeMax: S.String,
  limit: S.optional(S.Number),
});

export interface HomeErrorRateResult {
  readonly errorRate: number;
  readonly errorRateDelta: number;
  readonly sampledTraceCount: number;
}

function computeErrorRate(traces: ReadonlyArray<{ errorSpanCount?: number }>): {
  readonly errorRate: number;
  readonly sampledTraceCount: number;
} {
  const errorCount = traces.filter(
    (t) => t.errorSpanCount !== undefined && t.errorSpanCount > 0,
  ).length;
  const errorRate = traces.length > 0 ? (errorCount / traces.length) * 100 : 0;
  return { errorRate, sampledTraceCount: traces.length };
}

export const homeErrorRate = createServerFn({ method: 'GET' })
  .validator(S.standardSchemaV1(HomeErrorRateInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const limit = data.limit ?? 200;

    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;

      const startTime = new Date(data.startTimeMin);
      const endTime = new Date(data.startTimeMax);
      const windowMs = endTime.getTime() - startTime.getTime();
      const prevStartTime = new Date(startTime.getTime() - windowMs);
      const prevEndTime = startTime;

      const currentTraces = yield* backend.searchTraces({
        service: data.service,
        startTimeMin: data.startTimeMin,
        startTimeMax: data.startTimeMax,
        limit,
      });

      const prevTraces = yield* backend.searchTraces({
        service: data.service,
        startTimeMin: prevStartTime.toISOString(),
        startTimeMax: prevEndTime.toISOString(),
        limit,
      });

      const current = computeErrorRate(currentTraces);
      const prev = computeErrorRate(prevTraces);
      const errorRateDelta = current.errorRate - prev.errorRate;

      return {
        errorRate: current.errorRate,
        errorRateDelta,
        sampledTraceCount: current.sampledTraceCount,
      };
    });

    return RuntimeServer.runPromise(effect);
  });
