import { createServerFn } from '@tanstack/react-start';
import { IssueStore } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import {
  type SerializableIssue,
  type SerializableOccurrence,
  type SerializableOccurrenceBucket,
  serializeIssueDetail,
  serializeOccurrenceBuckets,
} from '#/server/issue-serialize';
import { RuntimeServer } from '#/server/runtime';

const GetIssueInputSchema = S.Struct({
  issueId: S.Number,
  page: S.optional(S.Number),
});

export type GetIssueResult = {
  readonly issue: SerializableIssue;
  readonly latestOccurrence: SerializableOccurrence | null;
  readonly histogram: ReadonlyArray<SerializableOccurrenceBucket>;
  readonly occurrences: ReadonlyArray<SerializableOccurrence>;
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_SPARKLINE_SLOTS = 14;

export const getIssue = createServerFn({ method: 'GET' })
  .validator(S.toStandardSchemaV1(GetIssueInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const page = data.page ?? 1;
    const since = new Date(Date.now() - DETAIL_SPARKLINE_SLOTS * DAY_MS);

    const effect = Effect.gen(function* () {
      const store = yield* IssueStore;
      const detail = yield* store.getIssueDetail(data.issueId);
      const histogram = yield* store.getOccurrenceHistogram(
        data.issueId,
        'day',
        since,
      );
      const paginated = yield* store.getIssueOccurrencesPaginated(
        data.issueId,
        page,
      );

      const serialized = serializeIssueDetail(detail);
      const occurrences: Array<SerializableOccurrence> = [];
      for (const occurrence of paginated.occurrences) {
        occurrences.push({
          id: occurrence.id,
          issueId: occurrence.issueId,
          traceId: occurrence.traceId,
          spanId: occurrence.spanId,
          serviceName: occurrence.serviceName,
          timestamp: occurrence.timestamp.getTime(),
          exceptionMessage: occurrence.exceptionMessage,
          exceptionStacktrace: occurrence.exceptionStacktrace,
        });
      }

      return {
        issue: serialized.issue,
        latestOccurrence: serialized.latestOccurrence,
        histogram: serializeOccurrenceBuckets(histogram),
        occurrences,
        page: paginated.page,
        pageSize: paginated.pageSize,
        totalCount: paginated.totalCount,
      };
    });

    return RuntimeServer.runPromise(effect);
  });
