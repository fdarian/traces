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
      seen: kept
        .filter((row) => input.position(row) === before)
        .map((row) => shortHash(input.key(row))),
    },
  };
};
