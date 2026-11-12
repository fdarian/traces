import { Effect } from 'effect';
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

/**
 * How an error scan finds error traces: `filtered` asks Jaeger to filter by
 * tag, `client` pages the unfiltered window and counts error spans itself.
 */
export type ErrorScanMode = 'filtered' | 'client';

export const toTraceCursor = (
  since: Date,
  next: PageResume,
  mode?: ErrorScanMode,
): Cursor => ({
  kind: 'jaeger-time',
  since: since.getTime(),
  before: next.before,
  seen: next.seen,
  ...(mode === undefined ? {} : { mode }),
});

export const fromTraceCursor = (cursor: Cursor) =>
  cursor.kind === 'jaeger-time'
    ? Effect.succeed({
        since: new Date(cursor.since),
        resume: {
          before: cursor.before,
          seen: cursor.seen,
        } satisfies PageResume,
        mode: cursor.mode,
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
  /** The mode that produced `next`; put it in the cursor so the next page does not retry the other one. */
  readonly mode: ErrorScanMode;
  readonly scanned: number;
  /** True when scanning stopped at `scanCap` with older traces left unread. */
  readonly capped: boolean;
}

export interface ErrorScanInput<E, R> {
  readonly limit: number;
  readonly scanCap: number;
  readonly pageSize: number;
  readonly resume?: PageResume;
  /** The mode of the pages before `resume`. Unset on a first page, which tries `filtered` and falls back to `client`. */
  readonly mode?: ErrorScanMode;
  /** `serverFiltered` tells the search to ask Jaeger for error traces only (`TraceQuery.errorsOnly`). */
  readonly fetchPage: (request: {
    readonly resume?: PageResume;
    readonly size: number;
    readonly serverFiltered: boolean;
  }) => Effect.Effect<BackwardPage<TraceSummary>, E, R>;
}

const scanPages = <E, R>(
  input: ErrorScanInput<E, R>,
  mode: ErrorScanMode,
): Effect.Effect<ErrorTraceScan, E, R> => {
  const serverFiltered = mode === 'filtered';
  const step = (
    resume: PageResume | undefined,
    scanned: number,
    collected: ReadonlyArray<TraceSummary>,
  ): Effect.Effect<ErrorTraceScan, E, R> =>
    Effect.gen(function* () {
      const page = yield* input.fetchPage({
        resume,
        size: Math.min(input.pageSize, input.scanCap - scanned),
        serverFiltered,
      });
      const newestFirst = [...page.kept].reverse();
      const hits: Array<TraceSummary> = [];
      for (const summary of newestFirst) {
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
          mode,
          scanned: nowScanned,
          capped: false,
        } satisfies ErrorTraceScan;
      }
      if (page.next === undefined) {
        return {
          matches: [...total].reverse(),
          mode,
          scanned: nowScanned,
          capped: false,
        } satisfies ErrorTraceScan;
      }
      if (nowScanned >= input.scanCap) {
        return {
          matches: [...total].reverse(),
          next: page.next,
          mode,
          scanned: nowScanned,
          capped: true,
        } satisfies ErrorTraceScan;
      }
      return yield* step(page.next, nowScanned, total);
    });
  return step(input.resume, 0, []);
};

/**
 * Finds traces with `errorSpanCount > 0`, newest to oldest, until `limit`
 * matches, the window ends, or `scanCap` traces were read. A first page asks
 * Jaeger to filter, so errors older than a busy window's newest traces are
 * reachable. Jaeger's memory backend answers an error filter with nothing
 * (jaegertracing/jaeger#8553), so a filtered search that returns no traces
 * falls back to paging the unfiltered window and filtering on the client.
 * A resumed page (`input.mode`) stays in the mode its first page settled on,
 * so an empty tail of the window does not rerun the fallback.
 * Matches are always verified from the summaries, never trusted from the server.
 */
export const scanErrorTraces = <E, R>(
  input: ErrorScanInput<E, R>,
): Effect.Effect<ErrorTraceScan, E, R> =>
  Effect.gen(function* () {
    if (input.mode !== undefined) return yield* scanPages(input, input.mode);
    const filtered = yield* scanPages(input, 'filtered');
    // A filter that returned traces but none with errors was ignored, so that pass already was a client scan.
    if (filtered.scanned > 0) return filtered;
    return yield* scanPages(input, 'client');
  });
