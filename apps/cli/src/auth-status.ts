import {
  checkRailwayToken,
  ProviderAuthError,
  ProviderNotFound,
} from '@traces/core';
import { Effect, Redacted } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { SecretRef } from '#/config.ts';
import { EnvVarMissing } from '#/errors.ts';
import {
  missingRailwayToken,
  type ResolvedProject,
  resolveSecretRef,
} from '#/resolve.ts';
import { SecretMissing } from '#/secrets.ts';
import { findVercelToken } from '#/vercel-token.ts';

export interface AuthStatus {
  readonly status: 'ok' | 'missing' | 'invalid';
  readonly detail: string;
}

const describeRef = (ref: SecretRef) =>
  'keychain' in ref ? `keychain ${ref.keychain}` : `env ${ref.env}`;

/** Reads the project through the token, so it also proves the token can see that Railway project. */
export const railwayAuthStatus = (
  resolved: ResolvedProject,
  railwayProjectId: string,
) =>
  Effect.gen(function* () {
    const ref = resolved.project.railway?.token;
    if (ref === undefined) {
      return {
        status: 'missing',
        detail: missingRailwayToken(resolved).hint,
      } as const satisfies AuthStatus;
    }
    const source = `token from ${describeRef(ref)}`;
    const secret = yield* resolveSecretRef(ref).pipe(Effect.result);
    if (secret._tag === 'Failure') {
      const error = secret.failure;
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
    const checked = yield* checkRailwayToken(
      railwayProjectId,
      Redacted.make(secret.success),
    ).pipe(Effect.result);
    if (checked._tag === 'Success') {
      return { status: 'ok', detail: source } as const satisfies AuthStatus;
    }
    const error = checked.failure;
    if (error instanceof ProviderAuthError) {
      return {
        status: 'invalid',
        detail: `${source}: ${error.hint}`,
      } as const satisfies AuthStatus;
    }
    if (error instanceof ProviderNotFound) {
      return {
        status: 'invalid',
        detail: `${source} cannot see ${error.what}; ${error.hint}`,
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
  return response.status === 200
    ? ({
        status: 'ok',
        detail: `token from ${found.success.source}`,
      } as const satisfies AuthStatus)
    : ({
        status: 'invalid',
        detail: `token from ${found.success.source} was rejected (HTTP ${response.status}); run \`vercel login\` or set VERCEL_TOKEN`,
      } as const satisfies AuthStatus);
});
