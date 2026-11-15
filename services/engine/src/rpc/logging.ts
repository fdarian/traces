import type { EffectWrapOptions } from '@orpc/effect';
import { ORPCError } from '@orpc/server';
import { Cause, Effect } from 'effect';

// Contract errors are ORPCErrors; anything else that fails or dies becomes an
// opaque 500 for the client, so the server log is the only place it shows up.
const isUnexpected = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) ||
      (Cause.isFailReason(reason) && !(reason.error instanceof ORPCError)),
  );

// Plugged in as the `effect/wrap` hook of the oRPC context, which wraps each
// handler's effect and still sees the full Cause (the thrown error does not).
export const logUnexpectedCauses = <A>(
  effect: Effect.Effect<A, unknown>,
  options: EffectWrapOptions,
) =>
  effect.pipe(
    Effect.tapCause((cause) =>
      isUnexpected(cause)
        ? Effect.logError(`rpc ${options.path.join('.')} failed`, cause)
        : Effect.void,
    ),
  );
