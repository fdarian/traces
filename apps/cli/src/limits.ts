/** Shared by the commands and their help text so the documented defaults cannot drift. */
export const LOGS_LIMIT = { default: 100, max: 1000 } as const;
export const DEPLOYS_LIMIT = { default: 10, max: 100 } as const;
export const SPANS_LIMIT = { default: 20, max: 200 } as const;
export const ERROR_CAP = 2000;
/** `errors` fetches the full trace of at most this many error traces per service. */
export const ERROR_TRACE_CAP = 200;
/** `spans --errors` reads at most this many traces looking for error ones. */
export const TRACE_SCAN_CAP = 1000;
export const TRACE_SCAN_PAGE = 100;
export const DEFAULT_WINDOW = '1h';
export const FOLLOW_INTERVAL_SECONDS = 2;

const HOUR_MS = 60 * 60 * 1000;
/** Shortest retention per provider (Railway Free 3d, Vercel Hobby 1h); a window starting inside it can legitimately be empty. */
export const SHORTEST_RETENTION_MS = {
  railway: 3 * 24 * HOUR_MS,
  vercel: HOUR_MS,
} as const;
