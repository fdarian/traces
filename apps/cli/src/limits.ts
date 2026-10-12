/** Shared by the commands and their help text so the documented defaults cannot drift. */
export const LOGS_LIMIT = { default: 100, max: 1000 } as const;
export const DEPLOYS_LIMIT = { default: 10, max: 100 } as const;
export const ERROR_CAP = 2000;
export const DEFAULT_WINDOW = '1h';
export const FOLLOW_INTERVAL_SECONDS = 2;
