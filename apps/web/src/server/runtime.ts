import { FetchHttpClient } from '@effect/platform';
import {
  IngesterLayer,
  type IssueStore,
  IssueStoreLayer,
  JaegerBackendLayer,
  type TraceBackend,
} from '@traces/core';
import { Effect, Exit, Layer, ManagedRuntime } from 'effect';

type RuntimeServices = TraceBackend | IssueStore;

const MainLayer = Layer.provide(
  Layer.mergeAll(JaegerBackendLayer, IssueStoreLayer, IngesterLayer),
  FetchHttpClient.layer,
) as Layer.Layer<RuntimeServices>;

const runtime = ManagedRuntime.make(MainLayer);

export const RuntimeServer = {
  runPromise: async <A, E>(effect: Effect.Effect<A, E, RuntimeServices>) => {
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isFailure(exit)) {
      const cause = Exit.causeOption(exit);
      throw new Error(String(cause));
    }
    return exit.value;
  },
  runSync: <A, E>(effect: Effect.Effect<A, E, RuntimeServices>) => {
    const exit = runtime.runSync(Effect.exit(effect));
    if (Exit.isFailure(exit)) {
      const cause = Exit.causeOption(exit);
      throw new Error(String(cause));
    }
    return exit.value;
  },
};
