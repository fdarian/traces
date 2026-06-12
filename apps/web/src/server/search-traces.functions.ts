import { createServerFn } from '@tanstack/react-start';
import { TraceBackend } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';
import { wrapErrorsMiddleware } from './errors/server-fn-middleware';

const SearchTracesInputSchema = S.Struct({
  service: S.String,
  startTimeMin: S.String,
  startTimeMax: S.String,
  operation: S.optional(S.String),
  minDuration: S.optional(S.String),
  maxDuration: S.optional(S.String),
  attributes: S.optional(S.Record({ key: S.String, value: S.String })),
  limit: S.optional(S.Number),
});

export const searchTraces = createServerFn({ method: 'GET' })
  .middleware([wrapErrorsMiddleware])
  .validator(S.decodeUnknownSync(SearchTracesInputSchema))
  .handler(async ({ data }) => {
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.searchTraces(data);
    });
    const result = await RuntimeServer.runPromise(effect);
    return result;
  });
