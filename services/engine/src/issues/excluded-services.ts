import { Config } from 'effect';

const DEFAULT_EXCLUDED_SERVICES = 'jaeger';
const EXCLUDE_NOTHING = 'none';

export function parseExcludedServices(raw: string): ReadonlySet<string> {
  if (raw.trim() === EXCLUDE_NOTHING) {
    return new Set();
  }
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return new Set(names);
}

/** Services the ingesters skip. Effect treats an empty env var as unset, so `INGEST_EXCLUDE_SERVICES=none` is how to exclude nothing. */
export const excludedServicesConfig = Config.String(
  'INGEST_EXCLUDE_SERVICES',
).pipe(
  Config.withDefault(DEFAULT_EXCLUDED_SERVICES),
  Config.map(parseExcludedServices),
);
