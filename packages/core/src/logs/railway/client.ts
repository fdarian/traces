import { Effect, Option, Schema, Stream } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import {
  ProviderAuthError,
  type ProviderError,
  ProviderNotFound,
  ProviderRequestError,
  ProviderResponseInvalid,
} from '../errors.js';
import { PROVIDER } from './normalize.js';
import { PROJECT_QUERY } from './queries.js';
import { Envelope, LinkedProject, ProjectData } from './schema.js';

const INSTALL_HINT =
  'install the Railway CLI (https://docs.railway.com/guides/cli) and run `railway login`';
const LOGIN_HINT = 'run `railway login`';

export interface Variables {
  readonly raw?: Readonly<Record<string, string | undefined>>;
  readonly json?: Readonly<Record<string, number | undefined>>;
}

const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

const looksUnauthorized = (text: string): boolean =>
  /not authorized|unauthorized|not logged in|please login|run `?railway login/i.test(
    text,
  );

/** Runs GraphQL documents through the user's logged-in `railway api`; no token handling. */
export const makeRailwayClient = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runCli = (args: ReadonlyArray<string>, cwd?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* ChildProcess.make(
          'railway',
          args,
          cwd === undefined ? {} : { cwd },
        ).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
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
            ? new ProviderAuthError({
                provider: PROVIDER,
                hint: INSTALL_HINT,
              })
            : new ProviderRequestError({ provider: PROVIDER, cause: error }),
      ),
    );

  const query = <A, I>(
    operation: string,
    document: string,
    variables: Variables,
    schema: Schema.Codec<A, I>,
  ): Effect.Effect<A, ProviderError, never> =>
    Effect.gen(function* () {
      const args = ['api', document, '--compact'];
      for (const [name, value] of Object.entries(variables.raw ?? {})) {
        if (value !== undefined) args.push('--raw-var', `${name}=${value}`);
      }
      for (const [name, value] of Object.entries(variables.json ?? {})) {
        if (value !== undefined) args.push('--var', `${name}=${value}`);
      }
      const result = yield* runCli(args);
      const envelope = Schema.decodeUnknownOption(Envelope)(result.stdout);
      const messages = Option.isSome(envelope)
        ? (envelope.value.errors ?? []).map((error) => error.message)
        : [];
      const detail =
        messages.length > 0
          ? messages.join('; ')
          : result.stderr.trim() || result.stdout.trim();
      if (looksUnauthorized(`${messages.join(' ')} ${result.stderr}`)) {
        return yield* new ProviderAuthError({
          provider: PROVIDER,
          hint: LOGIN_HINT,
        });
      }
      if (result.exitCode !== 0 || messages.length > 0) {
        return yield* new ProviderRequestError({
          provider: PROVIDER,
          cause: new Error(`railway api failed: ${detail}`),
        });
      }
      if (Option.isNone(envelope)) {
        return yield* new ProviderResponseInvalid({
          provider: PROVIDER,
          operation,
          cause: new Error(
            `not a JSON envelope: ${result.stdout.slice(0, 200)}`,
          ),
        });
      }
      return yield* Schema.decodeUnknownEffect(schema)(
        envelope.value.data,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderResponseInvalid({
              provider: PROVIDER,
              operation,
              cause,
            }),
        ),
      );
    });

  /** The project the folder is linked to, from `railway status --json`; Railway's own config files are never read. */
  const linkedProject = (
    cwd: string,
  ): Effect.Effect<{ readonly id: string }, ProviderError, never> =>
    Effect.gen(function* () {
      const result = yield* runCli(['status', '--json'], cwd);
      const output = `${result.stderr}\n${result.stdout}`;
      if (looksUnauthorized(output)) {
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
      return yield* Schema.decodeUnknownEffect(LinkedProject)(
        result.stdout,
      ).pipe(
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

  /** Every service and environment of a Railway project. */
  const projectLayout = (projectId: string) =>
    Effect.gen(function* () {
      const data = yield* query(
        'project',
        PROJECT_QUERY,
        { raw: { id: projectId } },
        ProjectData,
      );
      if (data.project === null) {
        return yield* new ProviderNotFound({
          provider: PROVIDER,
          what: `project ${projectId}`,
          hint: 'check the project id and that `railway whoami` can see it',
        });
      }
      return {
        services: data.project.services.edges.map((edge) => edge.node),
        environments: data.project.environments.edges.map((edge) => edge.node),
      };
    });

  return { query, linkedProject, projectLayout };
});
