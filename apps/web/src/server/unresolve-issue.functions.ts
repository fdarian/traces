import { createServerFn } from '@tanstack/react-start';
import { IssueStore } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const UnresolveIssueInputSchema = S.Struct({
  issueId: S.Number,
});

export const unresolveIssue = createServerFn({ method: 'POST' })
  .validator(S.toStandardSchemaV1(UnresolveIssueInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const effect = Effect.gen(function* () {
      const store = yield* IssueStore;
      yield* store.unresolveIssue(data.issueId);
    });
    await RuntimeServer.runPromise(effect);
    return { ok: true as const };
  });
