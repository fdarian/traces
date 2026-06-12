import { createServerFn } from '@tanstack/react-start';
import { TraceBackend } from '@traces/core';
import { Effect } from 'effect';
import { RuntimeServer } from '#/server/runtime';
import { wrapErrorsMiddleware } from './errors/server-fn-middleware';

export const listOperations = createServerFn({ method: 'GET' })
  .middleware([wrapErrorsMiddleware])
  .validator((data: unknown) => {
    if (typeof data !== 'string') {
      throw new Error('Expected string');
    }
    return data;
  })
  .handler(async ({ data }) => {
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.listOperations(data);
    });
    const result = await RuntimeServer.runPromise(effect);
    return result;
  });
