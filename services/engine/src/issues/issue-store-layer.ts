import { Config, Effect, Layer } from 'effect';
import { PgDbLayer } from '#/db/pg';
import { SqliteDbLayer } from '#/db/sqlite';
import { PgIssueStoreLayer } from '#/issues/pg-store';
import { SqliteIssueStoreLayer } from '#/issues/sqlite-store';

export const IssueStoreLayer = Layer.unwrap(
  Effect.gen(function* () {
    const databaseUrl = yield* Config.option(Config.String('DATABASE_URL'));
    if (databaseUrl._tag === 'Some') {
      return Layer.provide(PgIssueStoreLayer, PgDbLayer);
    }
    return Layer.provide(SqliteIssueStoreLayer, SqliteDbLayer);
  }),
);
