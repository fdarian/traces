import { createServerFn } from '@tanstack/react-start';
import { TraceBackend } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const ListOperationsInputSchema = S.String;

export const listOperations = createServerFn({ method: 'GET' })
  .validator(S.standardSchemaV1(ListOperationsInputSchema))
  .handler(async ({ data }) => {
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.listOperations(data);
    });
    const result = await RuntimeServer.runPromise(effect);
    return result;
  });
