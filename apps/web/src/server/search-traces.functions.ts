import { createServerFn } from '@tanstack/react-start';
import { TraceBackend } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const SearchTracesInputSchema = S.Struct({
  service: S.String,
  startTimeMin: S.String,
  startTimeMax: S.String,
  operation: S.optional(S.String),
  minDuration: S.optional(S.String),
  maxDuration: S.optional(S.String),
  attributes: S.optional(S.Record(S.String, S.String)),
  limit: S.optional(S.Number),
});

export const searchTraces = createServerFn({ method: 'GET' })
  .validator(S.toStandardSchemaV1(SearchTracesInputSchema))
  .handler(async (ctx) => {
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.searchTraces(ctx.data);
    });
    const result = await RuntimeServer.runPromise(effect);
    return result;
  });
