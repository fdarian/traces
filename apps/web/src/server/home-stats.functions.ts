import { createServerFn } from '@tanstack/react-start';
import { IssueStore, type IssueStoreStats } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const HomeStatsInputSchema = S.Struct({
  services: S.optional(S.Array(S.String)),
  startTime: S.Number,
  endTime: S.Number,
});

export type SerializableIssueStoreStats = {
  readonly occurrenceCount: number;
  readonly occurrenceDelta: number;
  readonly activeIssueCount: number;
  readonly activeIssueDelta: number;
  readonly serviceCount: number;
  readonly serviceDelta: number;
};

function serializeIssueStoreStats(
  stats: IssueStoreStats,
): SerializableIssueStoreStats {
  return {
    occurrenceCount: stats.occurrenceCount,
    occurrenceDelta: stats.occurrenceDelta,
    activeIssueCount: stats.activeIssueCount,
    activeIssueDelta: stats.activeIssueDelta,
    serviceCount: stats.serviceCount,
    serviceDelta: stats.serviceDelta,
  };
}

export const homeStats = createServerFn({ method: 'GET' })
  .validator(S.toStandardSchemaV1(HomeStatsInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const startTime = new Date(data.startTime);
    const endTime = new Date(data.endTime);
    const filter = {
      services:
        data.services !== undefined && data.services.length > 0
          ? data.services
          : undefined,
    };

    const effect = Effect.gen(function* () {
      const store = yield* IssueStore;
      const stats = yield* store.getStats(filter, startTime, endTime);
      return serializeIssueStoreStats(stats);
    });

    return RuntimeServer.runPromise(effect);
  });
