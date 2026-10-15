import { Effect } from 'effect';
import { UsageError } from '#/errors.ts';

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** `30m`, `2d` (relative to `now`) or an ISO timestamp. */
export const parseWhen = (flag: string, text: string, now: Date) => {
  const relative = /^(\d+)([smhdw])$/.exec(text);
  if (relative?.[1] !== undefined && relative[2] !== undefined) {
    const unit = UNIT_MS[relative[2]];
    if (unit !== undefined) {
      return Effect.succeed(
        new Date(now.getTime() - Number(relative[1]) * unit),
      );
    }
  }
  const parsed = /^\d{4}-\d{2}-\d{2}/.test(text)
    ? Date.parse(text)
    : Number.NaN;
  if (Number.isNaN(parsed)) {
    return Effect.fail(
      new UsageError({
        message: `cannot parse ${flag} "${text}"`,
        hint: 'use a duration like 30m, 1h, 2d or an ISO timestamp like 2026-10-12T08:00:00Z',
      }),
    );
  }
  return Effect.succeed(new Date(parsed));
};

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

/** `500ms`, `1s`, `1.5s`, `2m`, `1h`: `text` is what Jaeger accepts as-is, `ms` is for comparing bounds. */
export const parseDuration = (
  flag: string,
  text: string,
): Effect.Effect<{ text: string; ms: number }, UsageError> => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
  const unit =
    match?.[2] === undefined ? undefined : DURATION_UNIT_MS[match[2]];
  if (match?.[1] === undefined || unit === undefined) {
    return Effect.fail(
      new UsageError({
        message: `cannot parse ${flag} "${text}"`,
        hint: 'use a duration like 500ms, 1s, 1.5s, 2m or 1h',
      }),
    );
  }
  return Effect.succeed({ text, ms: Number(match[1]) * unit });
};
