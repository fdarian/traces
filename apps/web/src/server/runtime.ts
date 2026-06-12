import { type Effect, Exit, Layer, ManagedRuntime } from 'effect';

const MainLayer = Layer.empty;

const runtime = ManagedRuntime.make(MainLayer);

export const RuntimeServer = {
  runPromise: async <A, E>(effect: Effect.Effect<A, E, never>) => {
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isFailure(exit)) {
      const cause = Exit.causeOption(exit);
      throw new Error(String(cause));
    }
    return exit.value;
  },
};
