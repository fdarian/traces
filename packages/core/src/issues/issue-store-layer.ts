import { Config, Effect, Layer } from 'effect';
import { PgIssueStoreLayer } from './pg-store.js';
import { SqliteIssueStoreLayer } from './sqlite-store.js';

export const IssueStoreLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const databaseUrl = yield* Config.option(Config.string('DATABASE_URL'));
    if (databaseUrl._tag === 'Some') {
      return PgIssueStoreLayer;
    }
    return SqliteIssueStoreLayer;
  }),
);
