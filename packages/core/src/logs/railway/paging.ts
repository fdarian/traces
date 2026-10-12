import type { Cursor, LogQuery } from '../model.js';
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

/** Rows already delivered at the cursor timestamp come back again, so ask for that many extra. */
export const fetchLimitFor = (
  input: LogQuery,
  cursor: TimeCursor | undefined,
) =>
  Math.min(
    input.limit + (cursor === undefined ? 0 : cursor.seen.length),
    MAX_RAILWAY_LIMIT,
  );
