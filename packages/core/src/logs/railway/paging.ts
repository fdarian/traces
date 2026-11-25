import { Effect } from 'effect';
import type { Cursor } from '../model.js';
import { sortableIso } from '../normalize.js';
import { pageBackwards, pageWidening } from '../paging.js';

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
 * by `pageWidening`.
 */
const initialFetchLimit = (limit: number, cursor: TimeCursor | undefined) =>
  Math.min(
    limit + (cursor === undefined ? 0 : cursor.seen.length),
    MAX_RAILWAY_LIMIT,
  );

export const pageRailwayWidening = <A, E, R>(input: {
  readonly fetch: (fetchLimit: number) => Effect.Effect<ReadonlyArray<A>, E, R>;
  readonly timestamp: (row: A) => string;
  readonly key: (row: A) => string;
  readonly limit: number;
  readonly since?: number;
  readonly cursor?: TimeCursor;
}) =>
  pageWidening({
    fetch: input.fetch,
    page: (rows) => pageRailway({ ...input, rows }),
    limit: input.limit,
    initialFetchLimit: initialFetchLimit(input.limit, input.cursor),
    maxFetchLimit: MAX_RAILWAY_LIMIT,
  }).pipe(Effect.map((result) => result.page));
