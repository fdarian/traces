import { fileURLToPath } from 'node:url';
import { PgClient } from '@effect/sql-pg';
import {
  type EffectPgDatabase,
  makeWithDefaults,
} from 'drizzle-orm/effect-postgres';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { Config, Context, Effect, Layer } from 'effect';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle/pg', import.meta.url),
);

export type PgDb = EffectPgDatabase;
export const PgDb = Context.Service<PgDb>('traces/PgDb');

const PgClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* Config.Redacted('DATABASE_URL');
    return PgClient.layer({ url });
  }),
);

// Domains share this one layer instance so the connection and migrations run
// once per build; don't wrap it in a fresh Layer per domain.
export const PgDbLayer = Layer.effect(
  PgDb,
  Effect.gen(function* () {
    const db = yield* makeWithDefaults();
    yield* migrate(db, { migrationsFolder });
    return db;
  }),
).pipe(Layer.provide(PgClientLayer));
