import { createServerFn } from '@tanstack/react-start';
import {
  computeServiceHealth,
  type ServiceHealth,
  TraceBackend,
  type TraceSummary,
} from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const HomeServiceHealthInputSchema = S.Struct({
  startTimeMin: S.String,
  startTimeMax: S.String,
  limit: S.optional(S.Number),
});

export type SerializableServiceHealth = {
  readonly service: string;
  readonly traceCount: number;
  readonly errorRate: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
};

function serializeServiceHealth(
  health: ServiceHealth,
): SerializableServiceHealth {
  return {
    service: health.service,
    traceCount: health.traceCount,
    errorRate: health.errorRate,
    p50: health.p50,
    p95: health.p95,
    p99: health.p99,
  };
}

export const homeServiceHealth = createServerFn({ method: 'GET' })
  .validator(S.toStandardSchemaV1(HomeServiceHealthInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const limit = data.limit ?? 200;

    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      const services = yield* backend.listServices;

      const results = yield* Effect.forEach(
        services,
        (service) =>
          Effect.gen(function* () {
            const traces = yield* backend.searchTraces({
              service,
              startTimeMin: data.startTimeMin,
              startTimeMax: data.startTimeMax,
              limit,
            });
            const health = computeServiceHealth(service, traces);
            return serializeServiceHealth(health);
          }),
        { concurrency: 4 },
      );

      return results;
    });

    return RuntimeServer.runPromise(effect);
  });
