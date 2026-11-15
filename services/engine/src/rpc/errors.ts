import type { ORPCError, ORPCErrorConstructorMap } from '@orpc/server';
import type { jaegerErrors } from '@traces/contract';
import { JaegerBadResponse, JaegerUnreachable } from '@traces/core';
import { Effect } from 'effect';
import { IssueNotFound } from '#/issues/errors';

type JaegerError = JaegerUnreachable | JaegerBadResponse;

const isJaegerError = (error: unknown): error is JaegerError =>
  error instanceof JaegerUnreachable || error instanceof JaegerBadResponse;

// `errors` is the constructor map oRPC hands every handler; any procedure whose
// contract spreads `jaegerErrors` satisfies this parameter type.
export const mapJaegerErrors =
  (errors: ORPCErrorConstructorMap<typeof jaegerErrors>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(isJaegerError, (error) =>
        Effect.fail(
          error instanceof JaegerUnreachable
            ? errors.JAEGER_UNREACHABLE({ cause: error })
            : errors.JAEGER_BAD_RESPONSE({ cause: error }),
        ),
      ),
    );

// Structural instead of `ORPCErrorConstructorMap<typeof issueNotFoundErrors>`:
// that type's ErrorMap constraint rejects Effect Schemas outside the
// `@orpc/effect/extensions/schema` augmentation.
type IssueNotFoundConstructor = {
  readonly ISSUE_NOT_FOUND: (options: {
    readonly data: { readonly issueId: number };
  }) => ORPCError<'ISSUE_NOT_FOUND', { readonly issueId: number }>;
};

export const mapIssueNotFound =
  (errors: IssueNotFoundConstructor) =>
  <A, E, R>(effect: Effect.Effect<A, E | IssueNotFound, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error): error is IssueNotFound => error instanceof IssueNotFound,
        (error) =>
          Effect.fail(
            errors.ISSUE_NOT_FOUND({ data: { issueId: error.issueId } }),
          ),
      ),
    );
