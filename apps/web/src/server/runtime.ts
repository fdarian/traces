import {
  IngesterLayer,
  type IssueStore,
  IssueStoreLayer,
  JaegerBackendLayer,
  type TraceBackend,
} from '@traces/core';
import { Cause, Effect, Exit, Layer, ManagedRuntime } from 'effect';
import { FetchHttpClient } from 'effect/http';

type RuntimeServices = TraceBackend | IssueStore;

const JaegerWithHttp = Layer.provide(JaegerBackendLayer, FetchHttpClient.layer);

const IngesterWithDeps = Layer.provide(
  IngesterLayer,
  Layer.merge(JaegerWithHttp, IssueStoreLayer),
);

const MainLayer = Layer.mergeAll(
  JaegerWithHttp,
  IssueStoreLayer,
  IngesterWithDeps,
);

const runtime = ManagedRuntime.make(MainLayer);

const runToPromise = <A, E>(
  effect: Effect.Effect<A, E, RuntimeServices>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.promise(() => runtime.runPromiseExit(effect));
      if (Exit.isFailure(exit)) {
        return yield* Effect.fail(new Error(Cause.pretty(exit.cause)));
      }
      return exit.value;
    }),
  );

export const RuntimeServer = {
  runPromise: runToPromise,
  runSync: <A, E>(effect: Effect.Effect<A, E, RuntimeServices>) =>
    Effect.runSync(
      Effect.gen(function* () {
        const exit = yield* Effect.sync(() =>
          runtime.runSync(Effect.exit(effect)),
        );
        if (Exit.isFailure(exit)) {
          return yield* Effect.fail(new Error(Cause.pretty(exit.cause)));
        }
        return exit.value;
      }),
    ),
};
