import {
  Command,
  CommandExecutor,
  HttpClient,
  HttpClientRequest,
} from '@effect/platform';
import { Effect, Redacted, Stream } from 'effect';
import { findVercelToken } from '#/vercel-token.ts';

export interface AuthStatus {
  readonly status: 'ok' | 'missing' | 'invalid';
  readonly detail: string;
}

export const railwayAuthStatus = Effect.scoped(
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const process = yield* executor.start(Command.make('railway', 'whoami'));
    const exitCode = yield* Effect.all(
      [
        process.stdout.pipe(Stream.runDrain),
        process.stderr.pipe(Stream.runDrain),
        process.exitCode,
      ],
      { concurrency: 'unbounded' },
    ).pipe(Effect.map((results) => results[2]));
    return exitCode === 0
      ? ({ status: 'ok', detail: 'railway CLI logged in' } as const)
      : ({ status: 'invalid', detail: 'run `railway login`' } as const);
  }),
).pipe(
  Effect.catchTag('SystemError', (error) =>
    error.reason === 'NotFound'
      ? Effect.succeed({
          status: 'missing',
          detail:
            'railway CLI not installed (https://docs.railway.com/guides/cli)',
        } as const satisfies AuthStatus)
      : Effect.fail(error),
  ),
);

export const vercelAuthStatus = Effect.gen(function* () {
  const found = yield* findVercelToken.pipe(Effect.either);
  if (found._tag === 'Left') {
    return {
      status: 'missing',
      detail: found.left.hint,
    } as const satisfies AuthStatus;
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get('https://api.vercel.com/v2/user').pipe(
      HttpClientRequest.bearerToken(Redacted.value(found.right.token)),
    ),
  );
  return response.status === 200
    ? ({
        status: 'ok',
        detail: `token from ${found.right.source}`,
      } as const satisfies AuthStatus)
    : ({
        status: 'invalid',
        detail: `token from ${found.right.source} was rejected (HTTP ${response.status}); run \`vercel login\` or set VERCEL_TOKEN`,
      } as const satisfies AuthStatus);
});
