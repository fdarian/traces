import { Effect } from 'effect';
import { shortHash } from './normalize.js';

export interface PageResume {
  readonly before: string;
  readonly seen: ReadonlyArray<string>;
}

export interface BackwardPage<A> {
  readonly kept: ReadonlyArray<A>;
  /** Set when older rows exist; resume the next page from here. */
  readonly next?: PageResume;
}

/**
 * Both providers return the newest `limit + 1` rows of a window, ascending, and
 * their upper bound is inclusive, so the last row of one page reappears at the
 * top of the next. `position` must sort lexicographically; `key` identifies
 * rows that share a position.
 */
export const pageBackwards = <A>(input: {
  readonly rows: ReadonlyArray<A>;
  readonly position: (row: A) => string;
  readonly key: (row: A) => string;
  readonly limit: number;
  readonly resume?: PageResume;
}): BackwardPage<A> => {
  const resume = input.resume;
  const ordered = [...input.rows].sort((left, right) =>
    input.position(left).localeCompare(input.position(right)),
  );
  const fresh =
    resume === undefined
      ? ordered
      : ordered.filter((row) => {
          const comparison = input.position(row).localeCompare(resume.before);
          if (comparison > 0) return false;
          if (comparison < 0) return true;
          return !resume.seen.includes(shortHash(input.key(row)));
        });
  const hasMore = fresh.length > input.limit;
  const kept = hasMore ? fresh.slice(fresh.length - input.limit) : fresh;
  const oldest = kept[0];
  if (!hasMore || oldest === undefined) return { kept };
  const before = input.position(oldest);
  return {
    kept,
    next: {
      before,
      seen: [
        // Still in the resumed millisecond: rows delivered by earlier pages stay delivered.
        ...(resume !== undefined && before === resume.before
          ? resume.seen
          : []),
        ...kept
          .filter((row) => input.position(row) === before)
          .map((row) => shortHash(input.key(row))),
      ],
    },
  };
};

/**
 * The provider returns the newest `fetchLimit + 1` rows of the window. When
 * re-sent rows (dropped as already delivered) crowd out the fresh ones and the
 * fetch came back full, "no more" cannot be told from "cut short", so refetch
 * with room for exactly the rows that were dropped. `cutShort` is still set when
 * `maxFetchLimit` was reached without settling it.
 */
export const pageWidening = <
  Row,
  Page extends {
    readonly kept: ReadonlyArray<unknown>;
    readonly next?: unknown;
  },
  E,
  R,
>(input: {
  readonly fetch: (
    fetchLimit: number,
  ) => Effect.Effect<ReadonlyArray<Row>, E, R>;
  readonly page: (rows: ReadonlyArray<Row>) => Page;
  readonly limit: number;
  readonly initialFetchLimit: number;
  readonly maxFetchLimit: number;
}): Effect.Effect<
  {
    readonly rows: ReadonlyArray<Row>;
    readonly page: Page;
    readonly cutShort: boolean;
  },
  E,
  R
> => {
  const attempt = (
    fetchLimit: number,
  ): Effect.Effect<
    {
      readonly rows: ReadonlyArray<Row>;
      readonly page: Page;
      readonly cutShort: boolean;
    },
    E,
    R
  > =>
    Effect.gen(function* () {
      const rows = yield* input.fetch(fetchLimit);
      const page = input.page(rows);
      const cutShort = page.next === undefined && rows.length > fetchLimit;
      if (!cutShort || fetchLimit >= input.maxFetchLimit) {
        return { rows, page, cutShort };
      }
      const dropped = rows.length - page.kept.length;
      return yield* attempt(
        Math.min(input.limit + dropped, input.maxFetchLimit),
      );
    });
  return attempt(Math.min(input.initialFetchLimit, input.maxFetchLimit));
};
