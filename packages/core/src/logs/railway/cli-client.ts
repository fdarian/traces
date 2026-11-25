import { Effect, Schema, Stream } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import {
  ProviderAuthError,
  type ProviderError,
  ProviderNotFound,
  ProviderRequestError,
  ProviderResponseInvalid,
  ProviderToolMissing,
} from '../errors.js';
import {
  decodeEnvelopeData,
  looksUnauthorized,
  parseEnvelope,
  type RailwayClient,
  type Variables,
} from './client.js';
import { PROVIDER } from './normalize.js';
import { LinkedProject } from './schema.js';

const RAILWAY_CLI_INSTALL_HINT =
  'install the Railway CLI (https://docs.railway.com/guides/cli) and run `railway login`';
const LOGIN_HINT = 'run `railway login`';

const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

const NOT_LOGGED_IN = /not logged in|please login|run `?railway login/i;

const runRailwayCli = (
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
  args: ReadonlyArray<string>,
  cwd?: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* ChildProcess.make(
        'railway',
        args,
        cwd === undefined ? {} : { cwd },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collect(process.stdout), collect(process.stderr), process.exitCode],
        { concurrency: 'unbounded' },
      );
      return { stdout, stderr, exitCode };
    }),
  ).pipe(
    Effect.mapError(
      (error): ProviderError =>
        error.reason._tag === 'NotFound'
          ? new ProviderToolMissing({
              provider: PROVIDER,
              tool: 'railway',
              hint: RAILWAY_CLI_INSTALL_HINT,
            })
          : new ProviderRequestError({ provider: PROVIDER, cause: error }),
    ),
  );

const loggedOut = (texts: ReadonlyArray<string>): boolean =>
  looksUnauthorized(texts) || texts.some((text) => NOT_LOGGED_IN.test(text));

/** The project the folder is linked to, from `railway status --json`; Railway's own config files are never read. Always the CLI, whatever `railway.auth` says. */
export const railwayLinkedProject = (cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const result = yield* runRailwayCli(spawner, ['status', '--json'], cwd);
    const output = `${result.stderr}\n${result.stdout}`;
    if (loggedOut([output])) {
      return yield* new ProviderAuthError({
        provider: PROVIDER,
        hint: LOGIN_HINT,
      });
    }
    if (/no linked project/i.test(output)) {
      return yield* new ProviderNotFound({
        provider: PROVIDER,
        what: 'a linked project',
        hint: 'run `railway link` in the folder, or pass --railway-project',
      });
    }
    if (result.exitCode !== 0) {
      return yield* new ProviderRequestError({
        provider: PROVIDER,
        cause: new Error(
          `railway status failed: ${result.stderr.trim() || result.stdout.trim()}`,
        ),
      });
    }
    return yield* Schema.decodeUnknownEffect(LinkedProject)(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderResponseInvalid({
            provider: PROVIDER,
            operation: 'status',
            cause,
          }),
      ),
    );
  });

/** Runs GraphQL documents through the user's logged-in `railway api`; no token handling. */
export const makeRailwayCliClient = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runCli = (args: ReadonlyArray<string>) => runRailwayCli(spawner, args);

  const query = <A, I>(
    operation: string,
    document: string,
    variables: Variables,
    schema: Schema.Codec<A, I>,
  ): Effect.Effect<A, ProviderError> =>
    Effect.gen(function* () {
      const args = ['api', document, '--compact'];
      for (const [name, value] of Object.entries(variables)) {
        if (typeof value === 'string')
          args.push('--raw-var', `${name}=${value}`);
        else if (value !== undefined) args.push('--var', `${name}=${value}`);
      }
      const result = yield* runCli(args);
      const parsed = parseEnvelope(result.stdout);
      const texts = [...parsed.messages, result.stderr];
      if (loggedOut(texts)) {
        return yield* new ProviderAuthError({
          provider: PROVIDER,
          hint: LOGIN_HINT,
        });
      }
      if (result.exitCode !== 0 || parsed.messages.length > 0) {
        const detail =
          parsed.messages.length > 0
            ? parsed.messages.join('; ')
            : result.stderr.trim() || result.stdout.trim();
        return yield* new ProviderRequestError({
          provider: PROVIDER,
          cause: new Error(`railway api failed: ${detail}`),
        });
      }
      return yield* decodeEnvelopeData(
        operation,
        result.stdout,
        parsed,
        schema,
      );
    });

  return { query } satisfies RailwayClient;
});
