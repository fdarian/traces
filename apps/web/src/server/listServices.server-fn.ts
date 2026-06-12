import { createServerFn } from '@tanstack/react-start';
import { TraceBackend } from '@traces/core';
import { Effect } from 'effect';
import { RuntimeServer } from '#/server/runtime';

export const listServices = createServerFn({ method: 'GET' }).handler(
  async () => {
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.listServices;
    });
    const result = await RuntimeServer.runPromise(effect);
    return result;
  },
);
