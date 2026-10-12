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

const DOCS_DIR = join(import.meta.dirname, '..');

const devCommand = cli.Command.make('dev', {}, () =>
  Effect.gen(function* () {
    const session = yield* CurrentSession;
    const port = yield* getStickyPort(session);
    const url = `http://localhost:${port}`;

    yield* Effect.logInfo(`[dev] Using session: ${session} (${url})`);

    const blume = runManagedSubprocess('bun', [
      'run',
      'blume',
      'dev',
      '--port',
      String(port),
    ]);
    const publishWhenReady = Effect.gen(function* () {
      yield* Effect.tryPromise(() => fetch(url)).pipe(
        Effect.retry(Schedule.spaced('250 millis')),
      );
      yield* publishRunning({ url });
    });

    return yield* Effect.raceAll([
      blume,
      publishWhenReady.pipe(Effect.andThen(Effect.never)),
    ]);
  }).pipe(Effect.provide(CurrentSession.layer)),
);

const main = cli.Command.runWith(devCommand, { version: '0.0.1' });
main(process.argv.slice(2)).pipe(
  Effect.provide(DevSessions.layerAt(DOCS_DIR)),
  Effect.provide(BunServices.layer),
  Effect.scoped,
  BunRuntime.runMain,
);
