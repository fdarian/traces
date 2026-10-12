import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from '@effect/platform';
import { Effect, Redacted, Schema } from 'effect';
import {
  ProviderAuthError,
  type ProviderError,
  ProviderNotFound,
  ProviderRequestError,
  ProviderResponseInvalid,
} from '../errors.js';
import type { VercelTarget } from '../model.js';
import { PROVIDER } from './normalize.js';

const LOGIN_HINT = 'run `vercel login` or set VERCEL_TOKEN';

/** Authenticated JSON GETs against Vercel; `teamParams` scopes team-bound API calls. */
export const makeVercelClient = (
  target: VercelTarget,
  token: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const teamParams: Record<string, string> =
      target.team === undefined
        ? {}
        : target.team.startsWith('team_')
          ? { teamId: target.team }
          : { slug: target.team };

    const get = <A, I>(
      operation: string,
      url: string,
      params: Readonly<Record<string, string | undefined>>,
      schema: Schema.Schema<A, I>,
    ): Effect.Effect<A, ProviderError> =>
      Effect.gen(function* () {
        const definedParams: Record<string, string> = {};
        for (const [name, value] of Object.entries(params)) {
          if (value !== undefined) definedParams[name] = value;
        }
        const request = HttpClientRequest.get(url).pipe(
          HttpClientRequest.setUrlParams(definedParams),
          HttpClientRequest.bearerToken(Redacted.value(token)),
        );
        const response: HttpClientResponse.HttpClientResponse = yield* client
          .execute(request)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRequestError({ provider: PROVIDER, cause }),
            ),
          );
        if (response.status === 401 || response.status === 403) {
          return yield* new ProviderAuthError({
            provider: PROVIDER,
            hint: `${LOGIN_HINT} (the token was rejected for ${target.team === undefined ? 'this account' : `team "${target.team}"`})`,
          });
        }
        if (response.status === 404) {
          return yield* new ProviderNotFound({
            provider: PROVIDER,
            what: `${operation} (${url})`,
            hint: 'check `project` / `team` in the config',
          });
        }
        if (response.status >= 400) {
          const body = yield* response.text.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRequestError({ provider: PROVIDER, cause }),
            ),
          );
          return yield* new ProviderRequestError({
            provider: PROVIDER,
            cause: new Error(
              `${operation}: HTTP ${response.status}: ${body.slice(0, 300)}`,
            ),
          });
        }
        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) => new ProviderRequestError({ provider: PROVIDER, cause }),
          ),
        );
        return yield* Schema.decodeUnknown(schema)(json).pipe(
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

    return { teamParams, get };
  });
