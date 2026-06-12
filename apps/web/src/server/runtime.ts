import { FetchHttpClient } from '@effect/platform';
import { JaegerBackendLayer, type TraceBackend } from '@traces/core';
import { type Effect, Exit, Layer, ManagedRuntime } from 'effect';

const MainLayer = Layer.provide(
  JaegerBackendLayer,
  FetchHttpClient.layer,
) as Layer.Layer<TraceBackend>;

const runtime = ManagedRuntime.make(MainLayer);

export const RuntimeServer = {
  runPromise: async <A, E>(effect: Effect.Effect<A, E, TraceBackend>) => {
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isFailure(exit)) {
      const cause = Exit.causeOption(exit);
      throw new Error(String(cause));
    }
    return exit.value;
  },
};
