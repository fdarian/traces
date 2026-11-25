import { afterEach, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import {
  JaegerUnreachable,
  TraceBackend,
  type TraceBackendInterface,
  type TraceSummary,
} from '@traces/core';
import { ConfigProvider, Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { SqliteDbLayer } from '#/db/sqlite';
import { SqliteServiceStatsStoreLayer } from '#/service-stats/sqlite-store';
import { runStatsTickOnce } from '#/service-stats/stats-ingester';
import { HOUR_MS, ServiceStatsStore } from '#/service-stats/store';

const NS_PER_MS = BigInt(1_000_000);
const NOW = 500_000 * HOUR_MS;
const SETTLE_MS = 60_000;
const END = NOW - SETTLE_MS;
const LOOKBACK_MS = 600_000;
const START = END - LOOKBACK_MS;

interface FakeTrace {
  readonly service: string;
  readonly traceId: string;
  readonly startMs: number;
  /** Start times of the trace's other spans in the same service; a trace matches a search when any span starts in range. */
  readonly otherSpanStartsMs: ReadonlyArray<number>;
  readonly durationMs?: number;
}

interface SearchCall {
  readonly service: string;
  readonly startTimeMin: string;
  readonly startTimeMax: string;
  readonly returned: ReadonlyArray<string>;
}

let dbPath = '';

afterEach(() => {
  if (dbPath !== '') {
    try {
      unlinkSync(dbPath);
    } catch {
      // temp file may already be removed
    }
    dbPath = '';
  }
});

function fakeTrace(
  service: string,
  traceId: string,
  startMs: number,
  otherSpanStartsMs: ReadonlyArray<number> = [],
): FakeTrace {
  return { service, traceId, startMs, otherSpanStartsMs };
}

function parseRfc3339Nano(value: string): bigint {
  const match = /^(.*)\.(\d{1,9})Z$/.exec(value);
  if (match === null) {
    throw new Error(`not RFC3339Nano: ${value}`);
  }
  const wholeSecondsMs = Date.parse(`${match[1]}Z`);
  return (
    BigInt(wholeSecondsMs) * NS_PER_MS + BigInt((match[2] ?? '').padEnd(9, '0'))
  );
}

function summaryOf(trace: FakeTrace): TraceSummary {
  return {
    traceId: trace.traceId,
    rootService: trace.service,
    rootOperation: 'GET /',
    spanCount: 1 + trace.otherSpanStartsMs.length,
    errorSpanCount: 0,
    services: [{ name: trace.service, spanCount: 1 }],
    startTimeUnixNano: (BigInt(trace.startMs) * NS_PER_MS).toString(),
    durationMs: trace.durationMs === undefined ? 10 : trace.durationMs,
  };
}

function runTick(options: {
  services: ReadonlyArray<string>;
  traces: ReadonlyArray<FakeTrace>;
  env?: Record<string, string>;
  failingServices?: ReadonlyArray<string>;
}) {
  dbPath = `/tmp/traces-stats-ingester-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
  const calls: Array<SearchCall> = [];
  const backend: TraceBackendInterface = {
    listServices: Effect.succeed(options.services),
    listOperations: () => Effect.succeed([]),
    searchFullTraces: () => Effect.succeed([]),
    searchTagged: () => Effect.succeed(Option.none()),
    searchTraces: (query) => {
      if (options.failingServices?.includes(query.service)) {
        return Effect.fail(
          new JaegerUnreachable({ cause: new Error('jaeger down') }),
        );
      }
      const min = parseRfc3339Nano(query.startTimeMin);
      const max = parseRfc3339Nano(query.startTimeMax);
      const matches = options.traces.filter(
        (trace) =>
          trace.service === query.service &&
          [trace.startMs, ...trace.otherSpanStartsMs].some((startMs) => {
            const startNs = BigInt(startMs) * NS_PER_MS;
            return startNs >= min && startNs <= max;
          }),
      );
      const returned = matches.slice(0, query.limit);
      calls.push({
        service: query.service,
        startTimeMin: query.startTimeMin,
        startTimeMax: query.startTimeMax,
        returned: returned.map((trace) => trace.traceId),
      });
      return Effect.succeed(returned.map(summaryOf));
    },
    getTrace: (traceId) => Effect.succeed({ traceId, spans: [] }),
  };
  const configLayer = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      TRACES_DB: dbPath,
      STATS_SETTLE_MS: String(SETTLE_MS),
      STATS_INITIAL_LOOKBACK_MS: String(LOOKBACK_MS),
      ...options.env,
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(TraceBackend, backend),
    Layer.provide(SqliteServiceStatsStoreLayer, SqliteDbLayer),
    TestClock.layer(),
  ).pipe(Layer.provide(configLayer));

  const program = Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* runStatsTickOnce;
    const store = yield* ServiceStatsStore;
    const buckets = yield* store.readBuckets({
      services: undefined,
      resolution: 'minute',
      fromMs: 0,
      toMs: NOW * 2,
    });
    const gaps = yield* store.readGaps({
      services: undefined,
      fromMs: 0,
      toMs: NOW * 2,
    });
    const cursors = yield* store.listCursors();
    return { buckets, gaps, cursors };
  });
  return Effect.runPromise(
    program.pipe(Effect.provide(layer), Effect.provide(configLayer)),
  ).then((state) => ({
    calls,
    gaps: state.gaps,
    cursor: (service: string) =>
      state.cursors.find((cursor) => cursor.service === service),
    countFor: (service: string) =>
      state.buckets
        .filter((bucket) => bucket.service === service)
        .reduce((total, bucket) => total + bucket.traceCount, 0),
  }));
}

test('cold start walks forward from now - settle - lookback to the settled edge', async () => {
  const result = await runTick({
    services: ['web'],
    traces: [
      fakeTrace('web', 'a', START + 1000),
      fakeTrace('web', 'b', END - 5000),
    ],
  });
  expect(result.calls[0]?.startTimeMin).toBe(new Date(START).toISOString());
  expect(result.cursor('web')).toMatchObject({
    startedMs: START,
    forwardMs: END,
  });
  expect(result.countFor('web')).toBe(2);
});

test('a trace returned by two adjacent intervals is counted once', async () => {
  const firstEnd = START + 300_000;
  const result = await runTick({
    services: ['web'],
    traces: [fakeTrace('web', 'straddler', firstEnd - 2000, [firstEnd + 1000])],
  });
  expect(result.calls).toHaveLength(2);
  expect(result.calls[0]?.returned).toEqual(['straddler']);
  expect(result.calls[1]?.returned).toEqual(['straddler']);
  expect(result.countFor('web')).toBe(1);
});

test('a trace starting exactly at the interval end belongs only to the next interval', async () => {
  const firstEnd = START + 300_000;
  const result = await runTick({
    services: ['web'],
    traces: [fakeTrace('web', 'on-boundary', firstEnd)],
  });
  expect(result.calls).toHaveLength(2);
  expect(result.calls[0]?.startTimeMax).toBe(
    `${new Date(firstEnd - 1).toISOString().slice(0, -1)}999999Z`,
  );
  expect(result.calls[0]?.returned).toEqual([]);
  expect(result.calls[1]?.returned).toEqual(['on-boundary']);
  expect(result.countFor('web')).toBe(1);
});

test('hitting the limit halves the step and retries the same start without counting', async () => {
  const result = await runTick({
    services: ['web'],
    env: { STATS_TRACE_LIMIT: '3' },
    traces: [
      fakeTrace('web', 'a', START + 10_000),
      fakeTrace('web', 'b', START + 20_000),
      fakeTrace('web', 'c', START + 200_000),
    ],
  });
  expect(result.calls[0]?.startTimeMax).toContain(
    new Date(START + 300_000 - 1).toISOString().slice(0, -1),
  );
  expect(result.calls[0]?.returned).toHaveLength(3);
  expect(result.calls[1]?.startTimeMin).toBe(result.calls[0]?.startTimeMin);
  expect(result.calls[1]?.startTimeMax).toContain(
    new Date(START + 150_000 - 1).toISOString().slice(0, -1),
  );
  expect(result.calls[1]?.returned).toEqual(['a', 'b']);
  expect(result.gaps).toEqual([]);
  expect(result.countFor('web')).toBe(3);
  expect(result.cursor('web')?.forwardMs).toBe(END);
});

test('at the minimum step a still-full result is counted and recorded as a gap', async () => {
  const result = await runTick({
    services: ['web'],
    env: { STATS_TRACE_LIMIT: '3' },
    traces: [
      fakeTrace('web', 'a', START + 100),
      fakeTrace('web', 'b', START + 200),
      fakeTrace('web', 'c', START + 300),
      fakeTrace('web', 'd', START + 400),
    ],
  });
  expect(result.gaps).toEqual([
    { service: 'web', startMs: START, endMs: START + 5000 },
  ]);
  expect(result.countFor('web')).toBe(3);
  expect(result.cursor('web')?.forwardMs).toBe(END);
});

test('the per-service trace budget stops the loop and the next tick resumes from the cursor', async () => {
  const traces = Array.from({ length: 12 }, (_, index) =>
    fakeTrace('web', `t${index}`, START + index * 5000 + 100),
  );
  const result = await runTick({
    services: ['web'],
    env: {
      STATS_TRACE_LIMIT: '2',
      STATS_TICK_TRACE_BUDGET: '2',
      STATS_MAX_STEP_MS: '5000',
    },
    traces,
  });
  expect(result.calls).toHaveLength(2);
  expect(result.cursor('web')?.forwardMs).toBe(START + 10_000);
  expect(result.countFor('web')).toBe(2);
});

test('excluded services are never searched', async () => {
  const result = await runTick({
    services: ['jaeger', 'web'],
    traces: [
      fakeTrace('jaeger', 'j', START + 1000),
      fakeTrace('web', 'w', START + 1000),
    ],
  });
  expect(result.calls.every((call) => call.service === 'web')).toBe(true);
  expect(result.cursor('jaeger')).toBeUndefined();
  expect(result.countFor('jaeger')).toBe(0);
  expect(result.countFor('web')).toBe(1);
});

test("one service's Jaeger failure does not block the others", async () => {
  const result = await runTick({
    services: ['broken', 'web'],
    failingServices: ['broken'],
    traces: [fakeTrace('web', 'w', START + 1000)],
  });
  expect(result.cursor('broken')).toBeUndefined();
  expect(result.cursor('web')?.forwardMs).toBe(END);
  expect(result.countFor('web')).toBe(1);
});

test('a trace with a NaN duration fails only its own service and leaves other services counting', async () => {
  const result = await runTick({
    services: ['poisoned', 'web'],
    traces: [
      { ...fakeTrace('poisoned', 'p', START + 1000), durationMs: Number.NaN },
      fakeTrace('web', 'w', START + 1000),
    ],
  });
  expect(result.cursor('poisoned')).toBeUndefined();
  expect(result.countFor('poisoned')).toBe(0);
  expect(result.cursor('web')?.forwardMs).toBe(END);
  expect(result.countFor('web')).toBe(1);
});
