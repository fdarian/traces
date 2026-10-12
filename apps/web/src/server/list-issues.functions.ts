import { createServerFn } from '@tanstack/react-start';
import { IssueStore } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import {
  type SerializableIssue,
  type SerializableOccurrenceBucket,
  serializeListIssuesResult,
  serializeOccurrenceBuckets,
} from '#/server/issue-serialize';
import { RuntimeServer } from '#/server/runtime';

const ListIssuesInputSchema = S.Struct({
  status: S.Literals(['unresolved', 'resolved']),
  services: S.optional(S.Array(S.String)),
});

export type ListIssuesResult = {
  readonly issues: ReadonlyArray<
    SerializableIssue & {
      readonly histogram: ReadonlyArray<SerializableOccurrenceBucket>;
    }
  >;
  readonly summary: {
    readonly totalCount: number;
    readonly serviceCount: number;
  };
};

const HOUR_MS = 60 * 60 * 1000;
const LIST_SPARKLINE_SLOTS = 24;

export const listIssues = createServerFn({ method: 'GET' })
  .validator(S.toStandardSchemaV1(ListIssuesInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const since = new Date(Date.now() - LIST_SPARKLINE_SLOTS * HOUR_MS);

    const effect = Effect.gen(function* () {
      const store = yield* IssueStore;
      const filter = {
        status: data.status,
        services:
          data.services !== undefined && data.services.length > 0
            ? data.services
            : undefined,
      };
      const listed = yield* store.listIssuesWithSummary(filter);
      const issueIds = listed.issues.map((issue) => issue.id);
      const histograms = yield* store.getOccurrenceHistograms(
        issueIds,
        'hour',
        since,
      );

      const serialized = serializeListIssuesResult(listed);
      const issues: Array<
        SerializableIssue & {
          readonly histogram: ReadonlyArray<SerializableOccurrenceBucket>;
        }
      > = [];
      for (const issue of serialized.issues) {
        const buckets = histograms.get(issue.id) ?? [];
        issues.push({
          ...issue,
          histogram: serializeOccurrenceBuckets(buckets),
        });
      }

      return {
        issues,
        summary: serialized.summary,
      };
    });

    return RuntimeServer.runPromise(effect);
  });
