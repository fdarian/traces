import { fileURLToPath } from 'node:url';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { sql } from 'drizzle-orm';
import {
  type EffectSQLiteBunDatabase,
  makeWithDefaults,
} from 'drizzle-orm/effect-sqlite-bun';
import { migrate } from 'drizzle-orm/effect-sqlite-bun/migrator';
import { Config, Context, Effect, Layer } from 'effect';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle/sqlite', import.meta.url),
);

export type SqliteDb = EffectSQLiteBunDatabase;
export const SqliteDb = Context.Service<SqliteDb>('traces/SqliteDb');

const SqliteClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const filename = yield* Config.String('TRACES_DB').pipe(
      Config.withDefault('./traces.db'),
    );
    return SqliteClient.layer({ filename });
  }),
);

// Domains share this one layer instance so the connection and migrations run
// once per build; don't wrap it in a fresh Layer per domain.
export const SqliteDbLayer = Layer.effect(
  SqliteDb,
  Effect.gen(function* () {
    const db = yield* makeWithDefaults();
    yield* migrate(db, { migrationsFolder });
    // SQLite rebuild migrations drop tables, which would cascade-delete
    // occurrences if foreign keys were already enforced. Enable it afterwards;
    // the occurrences -> issues cascade relies on it, and @effect/sql-sqlite-bun
    // leaves it off.
    yield* db.run(sql`PRAGMA foreign_keys = ON`);
    return db;
  }),
).pipe(Layer.provide(SqliteClientLayer));
