import { createServerFn } from '@tanstack/react-start';
import { IssueStore, type TopIssue } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const HomeTopIssuesInputSchema = S.Struct({
  services: S.optional(S.Array(S.String)),
  limit: S.optional(S.Number),
  since: S.optional(S.Number),
});

export type SerializableTopIssue = {
  readonly id: number;
  readonly title: string;
  readonly service: string;
  readonly occurrenceCount: number;
  readonly lastSeen: number;
};

export type SerializableOccurrenceBucket = {
  readonly bucketStart: number;
  readonly count: number;
};

function serializeTopIssues(
  issues: ReadonlyArray<TopIssue>,
): ReadonlyArray<SerializableTopIssue> {
  const result: Array<SerializableTopIssue> = [];
  for (const issue of issues) {
    result.push({
      id: issue.id,
      title: issue.title,
      service: issue.service,
      occurrenceCount: issue.occurrenceCount,
      lastSeen: issue.lastSeen.getTime(),
    });
  }
  return result;
}

function serializeOccurrenceBuckets(
  buckets: ReadonlyArray<{ bucketStart: Date; count: number }>,
): ReadonlyArray<SerializableOccurrenceBucket> {
  const result: Array<SerializableOccurrenceBucket> = [];
  for (const bucket of buckets) {
    result.push({
      bucketStart: bucket.bucketStart.getTime(),
      count: bucket.count,
    });
  }
  return result;
}

export const homeTopIssues = createServerFn({ method: 'GET' })
  .validator(S.toStandardSchemaV1(HomeTopIssuesInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const filter = {
      services:
        data.services !== undefined && data.services.length > 0
          ? data.services
          : undefined,
    };
    const limit = data.limit ?? 8;
    const since =
      data.since !== undefined
        ? new Date(data.since)
        : new Date(Date.now() - 24 * 60 * 60 * 1000);

    const effect = Effect.gen(function* () {
      const store = yield* IssueStore;
      const issues = yield* store.getTopUnresolvedIssues(filter, limit);
      const issueIds = issues.map((i) => i.id);
      const histograms = yield* store.getOccurrenceHistograms(
        issueIds,
        'hour',
        since,
      );

      const serializedIssues = serializeTopIssues(issues);
      const serializedHistograms = new Map<
        number,
        ReadonlyArray<SerializableOccurrenceBucket>
      >();
      for (const issue of issues) {
        const buckets = histograms.get(issue.id) ?? [];
        serializedHistograms.set(issue.id, serializeOccurrenceBuckets(buckets));
      }

      return {
        issues: serializedIssues,
        histograms: serializedHistograms,
      };
    });

    return RuntimeServer.runPromise(effect);
  });
