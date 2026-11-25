import { Effect, Option, Schema } from 'effect';
import {
  type ProviderError,
  ProviderNotFound,
  ProviderResponseInvalid,
} from '../errors.js';
import { PROVIDER } from './normalize.js';
import { PROJECT_QUERY } from './queries.js';
import { Envelope, ProjectData } from './schema.js';

export type Variables = Readonly<Record<string, string | number | undefined>>;

/** Runs one Railway GraphQL document, whichever transport carries it. */
export interface RailwayClient {
  readonly query: <A, I>(
    operation: string,
    document: string,
    variables: Variables,
    schema: Schema.Codec<A, I>,
  ) => Effect.Effect<A, ProviderError>;
}

export interface ParsedEnvelope {
  readonly envelope: Option.Option<typeof Envelope.Type>;
  readonly messages: ReadonlyArray<string>;
}

export const parseEnvelope = (text: string): ParsedEnvelope => {
  const envelope = Schema.decodeUnknownOption(Envelope)(text);
  return {
    envelope,
    messages: Option.isSome(envelope)
      ? (envelope.value.errors ?? []).map((error) => error.message)
      : [],
  };
};

export const looksUnauthorized = (texts: ReadonlyArray<string>): boolean =>
  texts.some((text) => /not authorized|unauthorized/i.test(text));

/** Decodes the `data` of an error-free envelope; `text` is only quoted when it is not an envelope. */
export const decodeEnvelopeData = <A, I>(
  operation: string,
  text: string,
  parsed: ParsedEnvelope,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, ProviderResponseInvalid> => {
  if (Option.isNone(parsed.envelope)) {
    return new ProviderResponseInvalid({
      provider: PROVIDER,
      operation,
      cause: new Error(`not a JSON envelope: ${text.slice(0, 200)}`),
    });
  }
  return Schema.decodeUnknownEffect(schema)(parsed.envelope.value.data).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderResponseInvalid({ provider: PROVIDER, operation, cause }),
    ),
  );
};

/**
 * Proves the client can read one Railway project. Workspace tokens cannot run `me`, so
 * this project read is the only check that works for every token type and for the CLI login.
 */
export const checkRailwayAccess = (
  client: RailwayClient,
  projectId: string,
): Effect.Effect<void, ProviderError> =>
  Effect.gen(function* () {
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
