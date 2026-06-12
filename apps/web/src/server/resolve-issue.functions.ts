import { createServerFn } from '@tanstack/react-start';
import { IssueStore } from '@traces/core';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import { RuntimeServer } from '#/server/runtime';

const ResolveIssueInputSchema = S.Struct({
  issueId: S.Number,
});

export const resolveIssue = createServerFn({ method: 'POST' })
  .validator(S.standardSchemaV1(ResolveIssueInputSchema))
  .handler(async (ctx) => {
    const data = ctx.data;
    const effect = Effect.gen(function* () {
      const store = yield* IssueStore;
      yield* store.resolveIssue(data.issueId);
    });
    await RuntimeServer.runPromise(effect);
    return { ok: true as const };
  });
