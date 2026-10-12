import { createServerFn } from '@tanstack/react-start';
import { IssueStore, type TrendBucket } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const HomeTrendInputSchema = S.Struct({
  services: S.optional(S.Array(S.String)),
  startTime: S.Number,
  endTime: S.Number,
});

export type SerializableTrendBucket = {
  readonly bucketStart: number;
  readonly count: number;
};

function serializeTrendBuckets(
  buckets: ReadonlyArray<TrendBucket>,
): ReadonlyArray<SerializableTrendBucket> {
  const result: Array<SerializableTrendBucket> = [];
  for (const bucket of buckets) {
    result.push({
      bucketStart: bucket.bucketStart.getTime(),
      count: bucket.count,
    });
  }
  return result;
}

export const homeTrend = createServerFn({ method: 'GET' })
  .validator(S.toStandardSchemaV1(HomeTrendInputSchema))
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
      const buckets = yield* store.getOccurrenceTrend(
        filter,
        startTime,
        endTime,
      );
      return serializeTrendBuckets(buckets);
    });

    return RuntimeServer.runPromise(effect);
  });
