import { expect, test } from 'bun:test';
import { Cause, Context, Effect, Logger } from 'effect';
import { HttpServerResponse } from 'effect/http';
import { IssueNotFound, IssueStoreError } from '#/issues/errors';
import {
  IssueStore,
  type IssueStore as IssueStoreInterface,
} from '#/issues/store';
import { handler } from '#/rpc/handler';
import type { EngineContext } from '#/rpc/implementer';
import { logUnexpectedCauses } from '#/rpc/logging';

const failing = (failure: Effect.Effect<never, unknown>) =>
  ({
    getIssueDetail: () => failure,
  }) as unknown as IssueStoreInterface;

const run = async (failure: Effect.Effect<never, unknown>) => {
  const logs: Array<Logger.Options<unknown>> = [];
  const logger = Logger.make((options) => {
    logs.push(options);
  });
  const context = {
    'effect/context': Context.make(IssueStore, failing(failure)).pipe(
      Context.add(Logger.CurrentLoggers, new Set([logger])),
    ),
    'effect/wrap': logUnexpectedCauses,
  } as unknown as EngineContext;
  const response = await handler.handle(
    new Request('http://engine/rpc/issues/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { issueId: 1 } }),
    }),
    { prefix: '/rpc', context },
  );
  if (!response.matched) throw new Error('procedure not matched');
  return {
    status: HttpServerResponse.fromWeb(response.response).status,
    logs,
  };
};

test('a defect answers 500 and is logged as an error with its cause', async () => {
  const result = await run(Effect.die(new Error('kaboom')));
  expect(result.status).toBe(500);
  expect(result.logs).toHaveLength(1);
  expect(result.logs[0]?.logLevel).toBe('Error');
  expect(String(result.logs[0]?.message)).toContain('rpc issues.get failed');
  expect(Cause.pretty(result.logs[0]?.cause as Cause.Cause<unknown>)).toContain(
    'kaboom',
  );
});

test('an undefined store failure is logged', async () => {
  const result = await run(
    Effect.fail(new IssueStoreError({ cause: new Error('disk full') })),
  );
  expect(result.status).toBe(500);
  expect(result.logs).toHaveLength(1);
});

test('a defined contract error is answered with its status and not logged', async () => {
  const result = await run(Effect.fail(new IssueNotFound({ issueId: 1 })));
  expect(result.status).toBe(404);
  expect(result.logs).toHaveLength(0);
});
