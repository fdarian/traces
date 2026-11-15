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

const WEB_DIR = join(import.meta.dirname, '..');
const ENGINE_DIR = join(WEB_DIR, '../../services/engine');

// The engine keeps its sticky port in its own dev session, so asking for the
// same name from its DevSessions yields the port its dev script will bind.
// Not CurrentSession: layers are memoized by reference, so providing it again
// here would hand back the web session instead of the engine's.
const resolveEngineUrl = Effect.gen(function* () {
  const sessions = yield* DevSessions;
  const session = yield* sessions.getLatestOrCreate;
  const port = yield* getStickyPort(session, { name: 'engine' });
  return `http://localhost:${port}`;
}).pipe(Effect.provide(DevSessions.layerAt(ENGINE_DIR)));

const devCommand = cli.Command.make('dev', {}, () =>
  Effect.gen(function* () {
    const session = yield* CurrentSession;
    const port = yield* getStickyPort(session);
    const url = `http://localhost:${port}`;

    const externalEngineUrl = process.env.ENGINE_URL;
    const engineUrl = externalEngineUrl ?? (yield* resolveEngineUrl);
    const env: Record<string, string> = {
      PORT: String(port),
      ENGINE_URL: engineUrl,
    };

    yield* Effect.logInfo(`[dev] Using session: ${session} (${url})`);
    yield* Effect.logInfo(
      `[dev] Engine: ${engineUrl}${externalEngineUrl === undefined ? ' (spawned)' : ' (external)'}`,
    );

    const vite = runManagedSubprocess('bun', ['--bun', 'vite'], { env });
    const publishWhenReady = Effect.gen(function* () {
      yield* Effect.tryPromise(() => fetch(url)).pipe(
        Effect.retry(Schedule.spaced('250 millis')),
      );
      yield* publishRunning({ url });
    });

    const engine =
      externalEngineUrl === undefined
        ? runManagedSubprocess('bun', [join(ENGINE_DIR, 'scripts/dev.ts')])
        : Effect.never;

    return yield* Effect.raceAll([
      vite,
      engine,
      publishWhenReady.pipe(Effect.andThen(Effect.never)),
    ]);
  }).pipe(Effect.provide(CurrentSession.layer)),
);

const main = cli.Command.runWith(devCommand, { version: '0.0.1' });
main(process.argv.slice(2)).pipe(
  Effect.provide(DevSessions.layerAt(WEB_DIR)),
  Effect.provide(BunServices.layer),
  Effect.scoped,
  BunRuntime.runMain,
);
