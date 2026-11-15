import { join } from 'node:path';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {
  CurrentSession,
  DevSessions,
  getStickyPort,
  publishRunning,
  runManagedSubprocess,
} from 'devsess';
import { Effect, Schedule } from 'effect';
import * as cli from 'effect/cli';

const ENGINE_DIR = join(import.meta.dirname, '..');

const devCommand = cli.Command.make('dev', {}, () =>
  Effect.gen(function* () {
    const session = yield* CurrentSession;
    const port = yield* getStickyPort(session, { name: 'engine' });
    const url = `http://localhost:${port}`;

    const env: Record<string, string> = { PORT: String(port) };
    if (
      process.env.TRACES_DB === undefined &&
      process.env.DATABASE_URL === undefined
    ) {
      env.TRACES_DB = yield* session.path('traces.db');
    }

    yield* Effect.logInfo(`[dev] Using session: ${session} (${url})`);

    const engine = runManagedSubprocess(
      'bun',
      ['--watch', join(ENGINE_DIR, 'src/main.ts')],
      { env },
    );
    const publishWhenReady = Effect.gen(function* () {
      yield* Effect.tryPromise(() => fetch(`${url}/health`)).pipe(
        Effect.retry(Schedule.spaced('250 millis')),
      );
      yield* publishRunning({ url });
    });

    return yield* Effect.raceAll([
      engine,
      publishWhenReady.pipe(Effect.andThen(Effect.never)),
    ]);
  }).pipe(Effect.provide(CurrentSession.layer)),
);

const main = cli.Command.runWith(devCommand, { version: '0.0.1' });
main(process.argv.slice(2)).pipe(
  Effect.provide(DevSessions.layerAt(ENGINE_DIR)),
  Effect.provide(BunServices.layer),
  Effect.scoped,
  BunRuntime.runMain,
);
