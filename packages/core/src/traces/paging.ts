import { Effect } from 'effect';
import { TraceErrorCountsUnavailable } from '../errors.js';
import { InvalidCursor } from '../logs/errors.js';
import { type Cursor } from '../logs/model.js';
import { shortHash } from '../logs/normalize.js';
import {
  type BackwardPage,
  type PageResume,
  pageBackwards,
} from '../logs/paging.js';
import type { TraceSummary } from '../model.js';
import { nanoToIso } from '../normalize.js';

const position = (summary: TraceSummary) =>
  nanoToIso(summary.startTimeUnixNano);

/**
 * Jaeger has no cursor: it returns the newest traces of a window, so the next
 * page re-queries with the window's upper bound moved to the oldest start seen.
 */
export const pageTraces = (input: {
  readonly summaries: ReadonlyArray<TraceSummary>;
  readonly limit: number;
  readonly resume?: PageResume;
}): BackwardPage<TraceSummary> => {
  const byId = new Map(
    input.summaries.map((summary) => [summary.traceId, summary] as const),
  );
  return pageBackwards({
    rows: [...byId.values()],
    position,
    key: (summary) => summary.traceId,
    limit: input.limit,
    resume: input.resume,
  });
};

/** How many traces to ask Jaeger for: the page, one to detect more, and the boundary rows that reappear. */
export const traceFetchSize = (limit: number, resume?: PageResume): number =>
  limit + 1 + (resume?.seen.length ?? 0);

export const toTraceCursor = (since: Date, next: PageResume): Cursor => ({
  kind: 'jaeger-time',
  since: since.getTime(),
  before: next.before,
  seen: next.seen,
});

export const fromTraceCursor = (cursor: Cursor) =>
  cursor.kind === 'jaeger-time'
    ? Effect.succeed({
        since: new Date(cursor.since),
        resume: {
          before: cursor.before,
          seen: cursor.seen,
        } satisfies PageResume,
      })
    : Effect.fail(
        new InvalidCursor({
          cause: new Error(`a ${cursor.kind} cursor does not page traces`),
        }),
      );

export interface ErrorTraceScan {
  /** Oldest to newest, like every other page. */
  readonly matches: ReadonlyArray<TraceSummary>;
  readonly next?: PageResume;
  readonly scanned: number;
  /** True when scanning stopped at `scanCap` with older traces left unread. */
  readonly capped: boolean;
}

/**
 * Jaeger's error-tag search is unreliable, so errors are found by paging the
 * window newest to oldest and keeping traces with `errorSpanCount > 0`, until
 * `limit` matches, the window ends, or `scanCap` traces were read.
 */
export const scanErrorTraces = <E, R>(input: {
  readonly limit: number;
  readonly scanCap: number;
  readonly pageSize: number;
  readonly resume?: PageResume;
  readonly fetchPage: (request: {
    readonly resume?: PageResume;
    readonly size: number;
  }) => Effect.Effect<BackwardPage<TraceSummary>, E, R>;
}): Effect.Effect<ErrorTraceScan, E | TraceErrorCountsUnavailable, R> => {
  const step = (
    resume: PageResume | undefined,
    scanned: number,
    collected: ReadonlyArray<TraceSummary>,
  ): Effect.Effect<ErrorTraceScan, E | TraceErrorCountsUnavailable, R> =>
    Effect.gen(function* () {
      const page = yield* input.fetchPage({
        resume,
        size: Math.min(input.pageSize, input.scanCap - scanned),
      });
      const newestFirst = [...page.kept].reverse();
      const hits: Array<TraceSummary> = [];
      for (const summary of newestFirst) {
        if (summary.errorSpanCount === undefined) {
          return yield* new TraceErrorCountsUnavailable({
            traceId: summary.traceId,
          });
        }
        if (summary.errorSpanCount > 0) hits.push(summary);
      }
      const total = [...collected, ...hits];
      const nowScanned = scanned + page.kept.length;

      if (total.length >= input.limit) {
        const selected = total.slice(0, input.limit);
        const cut = selected[selected.length - 1];
        if (cut === undefined) {
          return yield* Effect.die(
            new Error('scanErrorTraces: limit must be at least 1'),
          );
        }
        const cutPosition = position(cut);
        const olderHitInPage = hits.some((hit) => !selected.includes(hit));
        const more = page.next !== undefined || olderHitInPage;
        return {
          matches: [...selected].reverse(),
          next: more
            ? {
                before: cutPosition,
                seen: selected
                  .filter((hit) => position(hit) === cutPosition)
                  .map((hit) => shortHash(hit.traceId)),
              }
            : undefined,
          scanned: nowScanned,
          capped: false,
        } satisfies ErrorTraceScan;
      }
      if (page.next === undefined) {
        return {
          matches: [...total].reverse(),
          scanned: nowScanned,
          capped: false,
        } satisfies ErrorTraceScan;
      }
      if (nowScanned >= input.scanCap) {
        return {
          matches: [...total].reverse(),
          next: page.next,
          scanned: nowScanned,
          capped: true,
        } satisfies ErrorTraceScan;
      }
      return yield* step(page.next, nowScanned, total);
    });
  return step(input.resume, 0, []);
};
