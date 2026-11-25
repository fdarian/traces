import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { ProviderAuthError } from '@traces/core';
import { Config, Effect, Option, Redacted, Schema } from 'effect';
import { FileSystem } from 'effect/FileSystem';

const LOGIN_HINT = 'run `vercel login` or set VERCEL_TOKEN';

const AuthFile = Schema.fromJsonString(Schema.Struct({ token: Schema.String }));

export const vercelAuthFilePath = (
  system: NodeJS.Platform,
  home: string,
  xdgDataHome: string | undefined,
) =>
  system === 'darwin'
    ? join(
        home,
        'Library',
        'Application Support',
        'com.vercel.cli',
        'auth.json',
      )
    : join(
        xdgDataHome ?? join(home, '.local', 'share'),
        'com.vercel.cli',
        'auth.json',
      );

export interface VercelToken {
  readonly token: Redacted.Redacted<string>;
  readonly source: 'VERCEL_TOKEN' | 'auth.json';
}

/** `VERCEL_TOKEN` wins over the CLI's `auth.json`; the token is never printed. */
export const findVercelToken: Effect.Effect<
  VercelToken,
  ProviderAuthError,
  FileSystem
> = Effect.gen(function* () {
  const fromEnv = yield* Config.String('VERCEL_TOKEN').pipe(
    Config.option,
    Effect.orDie,
  );
  if (Option.isSome(fromEnv)) {
    return {
      token: Redacted.make(fromEnv.value),
      source: 'VERCEL_TOKEN' as const,
    };
  }
  const xdgDataHome = yield* Config.String('XDG_DATA_HOME').pipe(
    Config.option,
    Effect.orDie,
  );
  const path = vercelAuthFilePath(
    platform(),
    homedir(),
    Option.getOrUndefined(xdgDataHome),
  );
  const fileSystem = yield* FileSystem;
  const content = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(
      () =>
        new ProviderAuthError({
          provider: 'vercel',
          hint: `no token found (looked for VERCEL_TOKEN and ${path}); ${LOGIN_HINT}`,
        }),
    ),
  );
  const parsed = yield* Schema.decodeUnknownEffect(AuthFile)(content).pipe(
    Effect.mapError(
      () =>
        new ProviderAuthError({
          provider: 'vercel',
          hint: `${path} has no "token" key (the CLI may keep it in the keyring); ${LOGIN_HINT}`,
        }),
    ),
  );
  return { token: Redacted.make(parsed.token), source: 'auth.json' as const };
});
