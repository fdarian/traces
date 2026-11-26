import {
  checkRailwayAccess,
  ProviderAuthError,
  ProviderNotFound,
  ProviderToolMissing,
} from '@traces/core';
import { Effect, Redacted } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { RailwayAuth, SecretRef } from '#/config.ts';
import { EnvVarMissing } from '#/errors.ts';
import {
  missingRailwayAuth,
  type ResolvedProject,
  resolveRailwayClient,
} from '#/resolve.ts';
import { SecretMissing, Secrets } from '#/secrets.ts';
import { findVercelToken } from '#/vercel-token.ts';

export interface AuthStatus {
  /** `error`: the provider could not answer the check (rate limit, outage), so the credentials are neither confirmed nor rejected. */
  readonly status: 'ok' | 'missing' | 'invalid' | 'error';
  readonly detail: string;
  /** Set when the Railway token is in the secrets file and the keychain too, so the keychain copy is never read. */
  readonly shadowedSecret?: string;
}

const describeAuth = (auth: RailwayAuth) => {
  if (auth === 'cli') return Effect.succeed({ label: 'railway CLI login' });
  if ('env' in auth) {
    return Effect.succeed({ label: `token from env ${auth.env}` });
  }
  return Secrets.use((secrets) => secrets.source(auth.keychain)).pipe(
    Effect.map((found) => ({
      label: `token from ${found.store} ${auth.keychain}`,
      ...(found.shadowed ? { shadowedSecret: auth.keychain } : {}),
    })),
  );
};

/** Reads the project through whichever transport is configured, so it also proves the credentials can see that Railway project. */
export const railwayAuthStatus = (
  resolved: ResolvedProject,
  railwayProjectId: string,
) =>
  Effect.gen(function* () {
    const auth = resolved.project.railway?.auth;
    if (auth === undefined) {
      return {
        status: 'missing',
        detail: missingRailwayAuth(resolved).hint,
      } as const satisfies AuthStatus;
    }
    const client = yield* resolveRailwayClient(resolved).pipe(Effect.result);
    if (client._tag === 'Failure') {
      const error = client.failure;
      if (error instanceof SecretMissing) {
        return {
          status: 'missing',
          detail: `traces secret set ${error.name}`,
        } as const satisfies AuthStatus;
      }
      if (error instanceof EnvVarMissing) {
        return {
          status: 'missing',
          detail: `export ${error.name}=<value>`,
        } as const satisfies AuthStatus;
      }
      return yield* Effect.fail(error);
    }
    const described = yield* describeAuth(auth);
    const source = described.label;
    const shadow =
      'shadowedSecret' in described
        ? { shadowedSecret: described.shadowedSecret }
        : {};
    const checked = yield* checkRailwayAccess(
      client.success,
      railwayProjectId,
    ).pipe(Effect.result);
    if (checked._tag === 'Success') {
      return {
        status: 'ok',
        detail: source,
        ...shadow,
      } as const satisfies AuthStatus;
    }
    const error = checked.failure;
    if (error instanceof ProviderToolMissing) {
      return {
        status: 'missing',
        detail: error.hint,
      } as const satisfies AuthStatus;
    }
    if (error instanceof ProviderAuthError) {
      return {
        status: 'invalid',
        detail: `${source}: ${error.hint}`,
        ...shadow,
      } as const satisfies AuthStatus;
    }
    if (error instanceof ProviderNotFound) {
      return {
        status: 'invalid',
        detail: `${source} cannot see ${error.what}; ${error.hint}`,
        ...shadow,
      } as const satisfies AuthStatus;
    }
    return yield* Effect.fail(error);
  });

export const vercelAuthStatus = Effect.gen(function* () {
  const found = yield* findVercelToken.pipe(Effect.result);
  if (found._tag === 'Failure') {
    return {
      status: 'missing',
      detail: found.failure.hint,
    } as const satisfies AuthStatus;
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get('https://api.vercel.com/v2/user').pipe(
      HttpClientRequest.bearerToken(Redacted.value(found.success.token)),
    ),
  );
  const source = found.success.source;
  if (response.status === 200) {
    return {
      status: 'ok',
      detail: `token from ${source}`,
    } as const satisfies AuthStatus;
  }
  if (response.status === 401 || response.status === 403) {
    return {
      status: 'invalid',
      detail: `token from ${source} was rejected (HTTP ${response.status}); run \`vercel login\` or set VERCEL_TOKEN`,
    } as const satisfies AuthStatus;
  }
  return {
    status: 'error',
    detail: `could not check the token from ${source}: the Vercel API answered HTTP ${response.status}; try again later`,
  } as const satisfies AuthStatus;
});
