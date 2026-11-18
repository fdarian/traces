import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { ConfigProvider, Effect, Layer } from 'effect';
import { SqliteDbLayer } from '#/db/sqlite';
import { planRange, readRangeStats } from '#/service-stats/range-stats';
import { SqliteServiceStatsStoreLayer } from '#/service-stats/sqlite-store';
import {
  type CountedTrace,
  HOUR_MS,
  MINUTE_MS,
  ServiceStatsStore,
} from '#/service-stats/store';

const NOW = 480_000 * HOUR_MS + 30 * MINUTE_MS + 20_000;
const RETENTION_MS = 26 * HOUR_MS;

function trace(
  traceId: string,
  startMs: number,
  overrides: Partial<CountedTrace> = {},
): CountedTrace {
  return {
    traceId,
    startMs,
    durationMs: 10,
    errorSpanCount: 0,
    rootService: 'gateway',
    rootOperation: 'GET /',
    spanCount: 3,
    ...overrides,
  };
}

function commit(
  service: string,
  input: {
    readonly startedMs: number;
    readonly forwardMs: number;
    readonly traces: ReadonlyArray<CountedTrace>;
    readonly gap?: { startMs: number; endMs: number };
  },
) {
  return Effect.gen(function* () {
    const store = yield* ServiceStatsStore;
    const cursor = yield* store.getCursor(service);
    const result = yield* store.commitStep({
      service,
      expectedForwardMs: cursor === null ? null : cursor.forwardMs,
      startedMs: input.startedMs,
      newForwardMs: input.forwardMs,
      nowMs: NOW,
      traces: input.traces,
      gap: input.gap ?? null,
    });
    if (result !== 'committed') {
      throw new Error('commit conflict in test setup');
    }
  });
}

function read(startMs: number, endMs: number, nowMs = NOW) {
  return readRangeStats({
    startMs,
    endMs,
    nowMs,
    minuteRetentionMs: RETENTION_MS,
    include: () => true,
  });
}

describe('planRange', () => {
  const plan = (startMs: number, endMs: number, nowMs = NOW) =>
    planRange({ startMs, endMs, nowMs, minuteRetentionMs: RETENTION_MS });

  test('whole hours from hour rows, edges from minute rows', () => {
    const start = NOW - 3 * HOUR_MS;
    const end = NOW;
    const result = plan(start, end);
    expect(result.hours).toEqual({
      startMs: 479_998 * HOUR_MS,
      endMs: 480_000 * HOUR_MS,
    });
    expect(result.minutes).toEqual([
      {
        startMs: Math.floor(start / MINUTE_MS) * MINUTE_MS,
        endMs: 479_998 * HOUR_MS,
      },
      {
        startMs: 480_000 * HOUR_MS,
        endMs: Math.ceil(end / MINUTE_MS) * MINUTE_MS,
      },
    ]);
  });

  test('a range inside one hour is a single minute span', () => {
    const start = 480_000 * HOUR_MS + 10 * MINUTE_MS;
    const result = plan(start, start + 20 * MINUTE_MS);
    expect(result.hours).toBeNull();
    expect(result.minutes).toEqual([
      { startMs: start, endMs: start + 20 * MINUTE_MS },
    ]);
  });

  test('an edge older than minute retention rounds out to the hour', () => {
    const start = NOW - 7 * 24 * HOUR_MS + 17 * MINUTE_MS;
    const result = plan(start, NOW);
    expect(result.hours).toEqual({
      startMs: Math.floor(start / HOUR_MS) * HOUR_MS,
      endMs: 480_000 * HOUR_MS,
    });
    expect(result.minutes).toHaveLength(1);
    expect(result.minutes[0]?.startMs).toBe(480_000 * HOUR_MS);
  });

  test('a whole range older than retention uses hour rows only', () => {
    const start = NOW - 14 * 24 * HOUR_MS;
    const result = plan(start, start + 7 * 24 * HOUR_MS);
    expect(result.minutes).toEqual([]);
    expect(result.hours).not.toBeNull();
  });
});

describe('readRangeStats', () => {
  let dbPath: string;
  let run: <A, E>(
    program: Effect.Effect<A, E, ServiceStatsStore>,
  ) => Promise<A>;

  beforeEach(() => {
    dbPath = `/tmp/traces-range-stats-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
    const layer = Layer.provide(
      Layer.provide(SqliteServiceStatsStoreLayer, SqliteDbLayer),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ TRACES_DB: dbPath })),
    );
    run = (program) => Effect.runPromise(Effect.provide(program, layer));
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {
      // temp file may already be removed
    }
  });

  const threeHourTraces = () => {
    const first = NOW - 3 * HOUR_MS - 7 * MINUTE_MS;
    const traces: CountedTrace[] = [];
    for (let minute = 0; minute < 3 * 60 + 14; minute += 1) {
      const startMs = first + minute * MINUTE_MS + 5000;
      traces.push(
        trace(`t${minute}`, startMs, {
          durationMs: 10 + (minute % 7) * 20,
          errorSpanCount: minute % 5 === 0 ? 1 : 0,
        }),
      );
    }
    return traces;
  };

  test('hour and minute stitching matches an all-minute sum over 3 h', async () => {
    const start = NOW - 3 * HOUR_MS;
    const end = NOW - 20_000;
    const result = await run(
      Effect.gen(function* () {
        yield* commit('api', {
          startedMs: NOW - 5 * HOUR_MS,
          forwardMs: NOW,
          traces: threeHourTraces(),
        });
        const store = yield* ServiceStatsStore;
        const minuteRows = yield* store.readBuckets({
          services: ['api'],
          resolution: 'minute',
          fromMs: Math.floor(start / MINUTE_MS) * MINUTE_MS,
          toMs: Math.ceil(end / MINUTE_MS) * MINUTE_MS,
        });
        return { stats: yield* read(start, end), minuteRows };
      }),
    );

    const expectedCount = result.minuteRows.reduce(
      (sum, row) => sum + row.traceCount,
      0,
    );
    const expectedErrors = result.minuteRows.reduce(
      (sum, row) => sum + row.errorTraceCount,
      0,
    );
    expect(expectedCount).toBeGreaterThan(150);
    const api = result.stats[0];
    expect(api?.traceCount).toBe(expectedCount);
    expect(api?.errorTraceCount).toBe(expectedErrors);
    expect(api?.errorRate).toBeCloseTo((expectedErrors / expectedCount) * 100);
    expect(api?.exact).toBe(true);
    expect(api?.p50).not.toBeNull();
  });

  test('minute-retention rounding reads the old edge from hour rows', async () => {
    const nowMs = NOW + 30 * HOUR_MS;
    const start = NOW - 3 * HOUR_MS + 17 * MINUTE_MS;
    const stats = await run(
      Effect.gen(function* () {
        yield* commit('api', {
          startedMs: NOW - 5 * HOUR_MS,
          forwardMs: NOW,
          traces: threeHourTraces(),
        });
        return {
          rounded: yield* read(start, NOW, nowMs),
          exactEdge: yield* read(start, NOW, NOW),
        };
      }),
    );
    const rounded = stats.rounded[0];
    const exactEdge = stats.exactEdge[0];
    if (rounded === undefined || exactEdge === undefined) {
      throw new Error('service missing');
    }
    // Rounded outward to the hour, so it includes the partial hour's earlier traces.
    expect(rounded.traceCount).toBeGreaterThan(exactEdge.traceCount);
  });

  test('cold start reports partial coverage and collectingSince', async () => {
    const start = NOW - 60 * MINUTE_MS;
    const startedMs = NOW - 15 * MINUTE_MS;
    const stats = await run(
      Effect.gen(function* () {
        yield* commit('api', {
          startedMs,
          forwardMs: NOW,
          traces: [trace('a', NOW - 10 * MINUTE_MS)],
        });
        return yield* read(start, NOW + HOUR_MS);
      }),
    );
    const api = stats[0];
    expect(api?.collectingSince).toBe(startedMs);
    expect(api?.coverage).toBeCloseTo(15 / 60);
    expect(api?.asOf).toBe(NOW);
    expect(api?.traceCount).toBe(1);
  });

  test('collection started before the range gives full coverage and no collectingSince', async () => {
    const stats = await run(
      Effect.gen(function* () {
        yield* commit('api', {
          startedMs: NOW - 5 * HOUR_MS,
          forwardMs: NOW,
          traces: [],
        });
        return yield* read(NOW - HOUR_MS, NOW);
      }),
    );
    expect(stats[0]?.coverage).toBe(1);
    expect(stats[0]?.collectingSince).toBeNull();
    expect(stats[0]?.traceCount).toBe(0);
    expect(stats[0]?.p50).toBeNull();
    expect(stats[0]?.errorRate).toBe(0);
  });

  test('a gap overlapping the range makes the stats inexact', async () => {
    const stats = await run(
      Effect.gen(function* () {
        yield* commit('api', {
          startedMs: NOW - 5 * HOUR_MS,
          forwardMs: NOW,
          traces: [trace('a', NOW - 40 * MINUTE_MS)],
          gap: { startMs: NOW - 41 * MINUTE_MS, endMs: NOW - 40 * MINUTE_MS },
        });
        yield* commit('web', {
          startedMs: NOW - 5 * HOUR_MS,
          forwardMs: NOW,
          traces: [],
        });
        return {
          overlapping: yield* read(NOW - HOUR_MS, NOW),
          after: yield* read(NOW - 30 * MINUTE_MS, NOW),
        };
      }),
    );
    expect(stats.overlapping[0]?.exact).toBe(false);
    expect(stats.after[0]?.exact).toBe(true);
  });

  test('the end clamps to the cursor and an unreached range is empty', async () => {
    const forwardMs = NOW - 30 * MINUTE_MS;
    const stats = await run(
      Effect.gen(function* () {
        yield* commit('api', {
          startedMs: NOW - 5 * HOUR_MS,
          forwardMs,
          traces: [trace('a', NOW - 45 * MINUTE_MS)],
        });
        return {
          clamped: yield* read(NOW - HOUR_MS, NOW),
          unreached: yield* read(NOW - 20 * MINUTE_MS, NOW),
        };
      }),
    );
    expect(stats.clamped[0]?.asOf).toBe(forwardMs);
    expect(stats.clamped[0]?.coverage).toBe(1);
    expect(stats.clamped[0]?.traceCount).toBe(1);
    expect(stats.unreached[0]).toMatchObject({
      traceCount: 0,
      coverage: 0,
      p50: null,
      errorRate: 0,
      asOf: forwardMs,
    });
  });

  test('services come back sorted and filtered by include', async () => {
    const names = await run(
      Effect.gen(function* () {
        for (const service of ['web', 'jaeger', 'api']) {
          yield* commit(service, {
            startedMs: NOW - HOUR_MS,
            forwardMs: NOW,
            traces: [],
          });
        }
        const stats = yield* readRangeStats({
          startMs: NOW - HOUR_MS,
          endMs: NOW,
          nowMs: NOW,
          minuteRetentionMs: RETENTION_MS,
          include: (service) => service !== 'jaeger',
        });
        return stats.map((entry) => entry.service);
      }),
    );
    expect(names).toEqual(['api', 'web']);
  });
});
