import { Effect, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import {
  ProviderAuthError,
  type ProviderError,
  ProviderNotFound,
  ProviderRequestError,
  ProviderResponseInvalid,
} from '../errors.js';
import { PROVIDER } from './normalize.js';
import { PROJECT_QUERY } from './queries.js';
import { Envelope, ProjectData } from './schema.js';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

const AUTH_HINT =
  'Railway rejected the token; use an account or workspace token with access to this project (check with traces services)';

export type Variables = Readonly<Record<string, string | number | undefined>>;

const looksUnauthorized = (messages: ReadonlyArray<string>): boolean =>
  messages.some((message) => /not authorized|unauthorized/i.test(message));

/** Railway GraphQL over HTTP, authenticated with an account or workspace token. */
export const makeRailwayClient = (token: Redacted.Redacted<string>) =>
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
        const envelope = Schema.decodeUnknownOption(Envelope)(text);
        const messages = Option.isSome(envelope)
          ? (envelope.value.errors ?? []).map((error) => error.message)
          : [];

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
        if (Option.isNone(envelope)) {
          return yield* new ProviderResponseInvalid({
            provider: PROVIDER,
            operation,
            cause: new Error(`not a JSON envelope: ${text.slice(0, 200)}`),
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

    return { query };
  });

/**
 * Proves the token works for one Railway project by reading it. Workspace tokens cannot
 * run `me`, so this project read is the only check that works for every token type.
 */
export const checkRailwayToken = (
  projectId: string,
  token: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const client = yield* makeRailwayClient(token);
    const data = yield* client.query(
      'project',
      PROJECT_QUERY,
      { id: projectId },
      ProjectData,
    );
    if (data.project === null) {
      return yield* new ProviderNotFound({
        provider: PROVIDER,
        what: `project ${projectId}`,
        hint: 'check `project` in the config',
      });
    }
  });
