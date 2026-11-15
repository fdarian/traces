import { Effect } from 'effect';
import {
  serializeIssueDetail,
  serializeListIssuesResult,
  serializeOccurrence,
  serializeOccurrenceBuckets,
} from '#/issues/issue-serialize';
import { servicesFilter } from '#/issues/services-filter';
import { IssueStore } from '#/issues/store';
import { mapIssueNotFound } from '#/rpc/errors';
import { os } from '#/rpc/implementer';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LIST_SPARKLINE_SLOTS = 24;
const DETAIL_SPARKLINE_SLOTS = 14;

const list = os.issues.list.effect(function* ({ input }) {
  const since = new Date(Date.now() - LIST_SPARKLINE_SLOTS * HOUR_MS);
  const store = yield* IssueStore;
  const listed = yield* store.listIssuesWithSummary({
    status: input.status,
    ...servicesFilter(input.services),
  });
  const histograms = yield* store.getOccurrenceHistograms(
    listed.issues.map((issue) => issue.id),
    'hour',
    since,
  );

  const serialized = serializeListIssuesResult(listed);
  return {
    issues: serialized.issues.map((issue) => ({
      ...issue,
      histogram: serializeOccurrenceBuckets(histograms.get(issue.id) ?? []),
    })),
    summary: serialized.summary,
  };
});

const get = os.issues.get.effect(function* ({ input, errors }) {
  const page = input.page ?? 1;
  const since = new Date(Date.now() - DETAIL_SPARKLINE_SLOTS * DAY_MS);
  const store = yield* IssueStore;
  return yield* Effect.gen(function* () {
    const detail = yield* store.getIssueDetail(input.issueId);
    const histogram = yield* store.getOccurrenceHistogram(
      input.issueId,
      'day',
      since,
    );
    const paginated = yield* store.getIssueOccurrencesPaginated(
      input.issueId,
      page,
    );

    const serialized = serializeIssueDetail(detail);
    return {
      issue: serialized.issue,
      latestOccurrence: serialized.latestOccurrence,
      histogram: serializeOccurrenceBuckets(histogram),
      occurrences: paginated.occurrences.map(serializeOccurrence),
      page: paginated.page,
      pageSize: paginated.pageSize,
      totalCount: paginated.totalCount,
    };
  }).pipe(mapIssueNotFound(errors));
});

const resolve = os.issues.resolve.effect(function* ({ input, errors }) {
  const store = yield* IssueStore;
  yield* store.resolveIssue(input.issueId).pipe(mapIssueNotFound(errors));
  return { ok: true as const };
});

const unresolve = os.issues.unresolve.effect(function* ({ input, errors }) {
  const store = yield* IssueStore;
  yield* store.unresolveIssue(input.issueId).pipe(mapIssueNotFound(errors));
  return { ok: true as const };
});

export const issuesRouter = { list, get, resolve, unresolve };
