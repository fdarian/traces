import { Effect } from 'effect';
import type { Cursor } from '../model.js';
import { sortableIso } from '../normalize.js';
import { pageBackwards } from '../paging.js';

const MAX_RAILWAY_LIMIT = 5000;

export type TimeCursor = Extract<Cursor, { kind: 'railway-time' }>;

export const pageRailway = <A>(input: {
  readonly rows: ReadonlyArray<A>;
  readonly timestamp: (row: A) => string;
  readonly key: (row: A) => string;
  readonly limit: number;
  readonly since?: number;
  readonly cursor?: TimeCursor;
}): { readonly kept: ReadonlyArray<A>; readonly next?: TimeCursor } => {
  const page = pageBackwards({
    rows: input.rows,
    position: (row) => sortableIso(input.timestamp(row)),
    key: input.key,
    limit: input.limit,
    resume: input.cursor,
  });
  if (page.next === undefined) return { kept: page.kept };
  return {
    kept: page.kept,
    next: {
      kind: 'railway-time',
      ...(input.since === undefined ? {} : { since: input.since }),
      before: page.next.before,
      seen: page.next.seen,
    },
  };
};

/**
 * A resumed window ends 1ms past the cursor, so it re-sends every row already
 * delivered in that millisecond, not only those at the cursor's exact time. The
 * cursor remembers just the latter, so this is a first guess; the rest is found
 * by `pageRailwayWidening`.
 */
const initialFetchLimit = (limit: number, cursor: TimeCursor | undefined) =>
  Math.min(
    limit + (cursor === undefined ? 0 : cursor.seen.length),
    MAX_RAILWAY_LIMIT,
  );

/**
 * The provider returns the newest `fetchLimit + 1` rows of the window. When
 * re-sent rows (dropped as already delivered) crowd out the fresh ones and the
 * fetch came back full, "no more" cannot be told from "cut short", so refetch
 * with room for exactly the rows that were dropped.
 */
export const pageRailwayWidening = <A, E, R>(input: {
  readonly fetch: (fetchLimit: number) => Effect.Effect<ReadonlyArray<A>, E, R>;
  readonly timestamp: (row: A) => string;
  readonly key: (row: A) => string;
  readonly limit: number;
  readonly since?: number;
  readonly cursor?: TimeCursor;
}): Effect.Effect<
  { readonly kept: ReadonlyArray<A>; readonly next?: TimeCursor },
  E,
  R
> => {
  const attempt = (
    fetchLimit: number,
  ): Effect.Effect<
    { readonly kept: ReadonlyArray<A>; readonly next?: TimeCursor },
    E,
    R
  > =>
    Effect.gen(function* () {
      const rows = yield* input.fetch(fetchLimit);
      const page = pageRailway({ ...input, rows });
      const cutShort =
        page.next === undefined &&
        rows.length > fetchLimit &&
        fetchLimit < MAX_RAILWAY_LIMIT;
      if (!cutShort) return page;
      const dropped = rows.length - page.kept.length;
      return yield* attempt(Math.min(input.limit + dropped, MAX_RAILWAY_LIMIT));
    });
  return attempt(initialFetchLimit(input.limit, input.cursor));
};
