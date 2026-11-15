import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { call, ORPCError } from '@orpc/server';
import {
  ErrorTraceSummary,
  GetIssueResult,
  HomeErrorRateResult,
  HomeStats,
  ListIssuesResult,
  ServiceHealth,
  Trace,
  TraceSummary,
  TrendBucket,
} from '@traces/contract';
import {
  type TraceSummary as CoreTraceSummary,
  TraceBackend,
  type TraceBackendInterface,
} from '@traces/core';
import { ConfigProvider, Context, Effect, Layer, Schema, Scope } from 'effect';
import { SqliteIssueStoreLayer } from '#/issues/sqlite-store';
import {
  IssueStore,
  type IssueStore as IssueStoreInterface,
} from '#/issues/store';
import type { EngineContext } from '#/rpc/implementer';
import { router } from '#/rpc/router';

const summary = (
  traceId: string,
  errorSpanCount: number | undefined,
): CoreTraceSummary => ({
  traceId,
  rootService: 'checkout',
  rootOperation: 'POST /pay',
  spanCount: 3,
  errorSpanCount,
  services: [{ name: 'checkout', spanCount: 3 }],
  startTimeUnixNano: '1700000000000000000',
  durationMs: 120,
});

const stubBackend: TraceBackendInterface = {
  listServices: Effect.succeed(['checkout', 'payments']),
  listOperations: () => Effect.succeed(['POST /pay']),
  searchTraces: () =>
    Effect.succeed([summary('t1', 1), summary('t2', undefined)]),
  getTrace: (traceId) =>
    Effect.succeed({
      traceId,
      spans: [
        {
          traceId,
          spanId: 's1',
          name: 'POST /pay',
          kind: 'server',
          startTimeUnixNano: '1700000000000000000',
          endTimeUnixNano: '1700000000120000000',
          durationMs: 120,
          status: { code: 'error', message: 'boom' },
          attributes: [{ key: 'http.method', value: 'POST' }],
          events: [],
          resource: { serviceName: 'checkout', attributes: [] },
        },
      ],
    }),
};

const dbPath = `/tmp/traces-engine-router-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
const scope = Scope.makeUnsafe();
let store: IssueStoreInterface;
let context: EngineContext;
let issueId: number;

beforeAll(async () => {
  const layer = Layer.provide(
    SqliteIssueStoreLayer,
    ConfigProvider.layer(ConfigProvider.fromUnknown({ TRACES_DB: dbPath })),
  );
  const services = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  store = Context.get(services, IssueStore);
  context = {
    'effect/context': Context.merge(
      services,
      Context.make(TraceBackend, stubBackend),
    ),
  };

  await Effect.runPromise(
    store.upsertOccurrence({
      fingerprint: 'fp-router',
      title: 'TypeError: x is undefined',
      service: 'checkout',
      exceptionType: 'TypeError',
      traceId: 't1',
      spanId: 's1',
      serviceName: 'checkout',
      timestamp: Date.now(),
      exceptionMessage: 'x is undefined',
      exceptionStacktrace: 'TypeError: x is undefined\n    at pay (pay.ts:1:1)',
      attributes: {},
    }),
  );
  const issues = await Effect.runPromise(store.listIssues({}));
  const first = issues[0];
  if (first === undefined) throw new Error('seeded issue missing');
  issueId = first.id;
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Effect.void as never));
  try {
    unlinkSync(dbPath);
  } catch {
    // temp file may already be removed
  }
});

const window = {
  startTime: Date.now() - 24 * 60 * 60 * 1000,
  endTime: Date.now() + 60 * 1000,
};
const traceWindow = {
  service: 'checkout',
  startTimeMin: '2023-11-14T00:00:00.000Z',
  startTimeMax: '2023-11-15T00:00:00.000Z',
};

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the procedure to fail');
    },
    (caught: unknown) => caught,
  );

describe('traces.*', () => {
  test('listServices', async () => {
    expect(
      await call(router.traces.listServices, undefined, { context }),
    ).toEqual(['checkout', 'payments']);
  });

  test('listOperations', async () => {
    expect(
      await call(router.traces.listOperations, 'checkout', { context }),
    ).toEqual(['POST /pay']);
  });

  test('search', async () => {
    const result = await call(router.traces.search, traceWindow, { context });
    expect(
      Schema.decodeUnknownSync(Schema.Array(TraceSummary))(result),
    ).toHaveLength(2);
  });

  test('get', async () => {
    const result = await call(
      router.traces.get,
      { traceId: 'abc' },
      { context },
    );
    expect(Schema.decodeUnknownSync(Trace)(result).spans).toHaveLength(1);
  });
});

describe('issues.*', () => {
  test('list', async () => {
    const result = await call(
      router.issues.list,
      { status: 'unresolved' },
      { context },
    );
    const decoded = Schema.decodeUnknownSync(ListIssuesResult)(result);
    expect(decoded.summary).toEqual({ totalCount: 1, serviceCount: 1 });
    expect(decoded.issues[0]?.id).toBe(issueId);
    expect(decoded.issues[0]?.histogram.length).toBeGreaterThan(0);
  });

  test('get', async () => {
    const result = await call(router.issues.get, { issueId }, { context });
    const decoded = Schema.decodeUnknownSync(GetIssueResult)(result);
    expect(decoded.issue.title).toBe('TypeError: x is undefined');
    expect(decoded.occurrences).toHaveLength(1);
    expect(decoded.latestOccurrence?.traceId).toBe('t1');
  });

  test('get on a missing issue yields ISSUE_NOT_FOUND', async () => {
    const error = await rejection(
      call(router.issues.get, { issueId: 9999 }, { context }),
    );
    if (!(error instanceof ORPCError)) throw error;
    expect(error.code).toBe('ISSUE_NOT_FOUND');
    expect(error.data).toEqual({ issueId: 9999 });
  });

  test('resolve and unresolve on a missing issue yield ISSUE_NOT_FOUND', async () => {
    for (const procedure of [router.issues.resolve, router.issues.unresolve]) {
      const error = await rejection(
        call(procedure, { issueId: 9999 }, { context }),
      );
      if (!(error instanceof ORPCError)) throw error;
      expect(error.code).toBe('ISSUE_NOT_FOUND');
      expect(error.data).toEqual({ issueId: 9999 });
    }
  });

  test('resolve then unresolve round-trips the issue status', async () => {
    const statusOf = async () =>
      (await call(router.issues.get, { issueId }, { context })).issue.status;

    expect(await call(router.issues.resolve, { issueId }, { context })).toEqual(
      {
        ok: true,
      },
    );
    expect(await statusOf()).toBe('resolved');
    expect(
      (
        await call(router.issues.list, { status: 'resolved' }, { context })
      ).issues.map((issue) => issue.id),
    ).toEqual([issueId]);

    expect(
      await call(router.issues.unresolve, { issueId }, { context }),
    ).toEqual({
      ok: true,
    });
    expect(await statusOf()).toBe('unresolved');
  });
});

describe('home.*', () => {
  test('stats', async () => {
    const result = await call(router.home.stats, window, { context });
    expect(Schema.decodeUnknownSync(HomeStats)(result).occurrenceCount).toBe(1);
  });

  test('trend', async () => {
    const result = await call(router.home.trend, window, { context });
    const decoded = Schema.decodeUnknownSync(Schema.Array(TrendBucket))(result);
    expect(decoded.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);
  });

  test('topIssues', async () => {
    const result = await call(router.home.topIssues, {}, { context });
    expect(result.issues.map((issue) => issue.id)).toEqual([issueId]);
    expect(result.histograms.get(issueId)?.length).toBeGreaterThan(0);
  });

  test('errorRate', async () => {
    const result = await call(router.home.errorRate, traceWindow, { context });
    const decoded = Schema.decodeUnknownSync(HomeErrorRateResult)(result);
    expect(decoded).toEqual({
      errorRate: 50,
      errorRateDelta: 0,
      sampledTraceCount: 2,
    });
  });

  test('serviceHealth', async () => {
    const result = await call(
      router.home.serviceHealth,
      {
        startTimeMin: traceWindow.startTimeMin,
        startTimeMax: traceWindow.startTimeMax,
      },
      { context },
    );
    const decoded = Schema.decodeUnknownSync(Schema.Array(ServiceHealth))(
      result,
    );
    expect(decoded.map((health) => health.service)).toEqual([
      'checkout',
      'payments',
    ]);
  });

  test('recentErrorTraces keeps only traces with error spans', async () => {
    const result = await call(router.home.recentErrorTraces, traceWindow, {
      context,
    });
    const decoded = Schema.decodeUnknownSync(Schema.Array(ErrorTraceSummary))(
      result,
    );
    expect(decoded.map((trace) => trace.traceId)).toEqual(['t1']);
  });
});
