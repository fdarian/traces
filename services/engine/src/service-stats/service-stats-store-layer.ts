import { Config, Effect, Layer } from 'effect';
import { PgDbLayer } from '#/db/pg';
import { SqliteDbLayer } from '#/db/sqlite';
import { PgServiceStatsStoreLayer } from '#/service-stats/pg-store';
import { SqliteServiceStatsStoreLayer } from '#/service-stats/sqlite-store';

export const ServiceStatsStoreLayer = Layer.unwrap(
  Effect.gen(function* () {
    const databaseUrl = yield* Config.option(Config.String('DATABASE_URL'));
    if (databaseUrl._tag === 'Some') {
      return Layer.provide(PgServiceStatsStoreLayer, PgDbLayer);
    }
    return Layer.provide(SqliteServiceStatsStoreLayer, SqliteDbLayer);
  }),
);
