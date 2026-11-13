import { Effect, Redacted, type Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import {
  ProviderAuthError,
  type ProviderError,
  ProviderRequestError,
} from '../errors.js';
import {
  decodeEnvelopeData,
  looksUnauthorized,
  parseEnvelope,
  type RailwayClient,
  type Variables,
} from './client.js';
import { PROVIDER } from './normalize.js';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

const AUTH_HINT =
  'Railway rejected the token; use an account or workspace token with access to this project (check with traces services)';

/** Railway GraphQL over HTTP, authenticated with an account or workspace token. */
export const makeRailwayHttpClient = (token: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const query = <A, I>(
      operation: string,
      document: string,
      variables: Variables,
      schema: Schema.Codec<A, I>,
    ): Effect.Effect<A, ProviderError> =>
      Effect.gen(function* () {
        const definedVariables: Record<string, string | number> = {};
        for (const [name, value] of Object.entries(variables)) {
          if (value !== undefined) definedVariables[name] = value;
        }
        const request = HttpClientRequest.post(ENDPOINT).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.bodyJsonUnsafe({
            query: document,
            variables: definedVariables,
          }),
        );
        const requestError = (cause: unknown) =>
          new ProviderRequestError({ provider: PROVIDER, cause });
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError(requestError));
        const text = yield* response.text.pipe(Effect.mapError(requestError));
        const parsed = parseEnvelope(text);
        const messages = parsed.messages;

        if (
          response.status === 401 ||
          response.status === 403 ||
          looksUnauthorized(messages)
        ) {
          return yield* new ProviderAuthError({
            provider: PROVIDER,
            hint: AUTH_HINT,
          });
        }
        if (response.status === 429) {
          return yield* new ProviderRequestError({
            provider: PROVIDER,
            cause: new Error('rate limited by Railway'),
          });
        }
        if (response.status < 200 || response.status >= 300) {
          const detail = messages.length > 0 ? messages.join('; ') : text;
          return yield* new ProviderRequestError({
            provider: PROVIDER,
            cause: new Error(
              `${operation}: HTTP ${response.status}: ${detail.slice(0, 300)}`,
            ),
          });
        }
        if (messages.length > 0) {
          return yield* new ProviderRequestError({
            provider: PROVIDER,
            cause: new Error(
              `${operation}: HTTP ${response.status}: ${messages.join('; ')}`,
            ),
          });
        }
        return yield* decodeEnvelopeData(operation, text, parsed, schema);
      });

    return { query } satisfies RailwayClient;
  });
