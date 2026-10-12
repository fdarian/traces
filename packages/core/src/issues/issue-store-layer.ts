import { Config, Effect, Layer } from 'effect';
import { PgIssueStoreLayer } from './pg-store.js';
import { SqliteIssueStoreLayer } from './sqlite-store.js';

export const IssueStoreLayer = Layer.unwrap(
  Effect.gen(function* () {
    const databaseUrl = yield* Config.option(Config.String('DATABASE_URL'));
    if (databaseUrl._tag === 'Some') {
      return PgIssueStoreLayer;
    }
    return SqliteIssueStoreLayer;
  }),
);
