import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { ConfigProvider, Effect, Layer } from 'effect';
import { PgDb, PgDbLayer } from '#/db/pg';
import { SqliteDbLayer } from '#/db/sqlite';
import {
  mergeSketches,
  quantile,
  sketchCount,
  sketchFromDurations,
} from '#/service-stats/latency-sketch';
import { PgServiceStatsStoreLayer } from '#/service-stats/pg-store';
import { SqliteServiceStatsStoreLayer } from '#/service-stats/sqlite-store';
import {
  type CountedTrace,
  HOUR_MS,
  MINUTE_MS,
  ServiceStatsStore,
} from '#/service-stats/store';

const DAY_MS = 24 * HOUR_MS;
// Hour-aligned so bucket arithmetic in the tests is exact.
const NOW = 480_000 * HOUR_MS + 48 * HOUR_MS;

type Run = <A, E>(
  program: Effect.Effect<A, E, ServiceStatsStore>,
) => Promise<A>;

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

function errorTrace(traceId: string, startMs: number): CountedTrace {
  return trace(traceId, startMs, { errorSpanCount: 1 });
}

/** Commits through the service's current cursor, creating it when missing. */
function commit(
  service: string,
  traces: ReadonlyArray<CountedTrace>,
  options: {
    readonly newForwardMs?: number;
    readonly gap?: { startMs: number; endMs: number };
  } = {},
) {
  return Effect.gen(function* () {
    const store = yield* ServiceStatsStore;
    const cursor = yield* store.getCursor(service);
    return yield* store.commitStep({
      service,
      expectedForwardMs: cursor === null ? null : cursor.forwardMs,
      startedMs: NOW - HOUR_MS,
      newForwardMs: options.newForwardMs ?? NOW,
      nowMs: NOW,
      traces,
      gap: options.gap ?? null,
    });
  });
}

function minuteBuckets(services?: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const store = yield* ServiceStatsStore;
    return yield* store.readBuckets({
      services,
      resolution: 'minute',
      fromMs: 0,
      toMs: NOW * 2,
    });
  });
}

function storeSuite(
  name: string,
  setup: () => Promise<{ run: Run; cleanup: () => void }>,
  skip = false,
) {
  (skip ? describe.skip : describe)(name, () => {
    let run: Run;
    let cleanup: () => void;

    beforeEach(async () => {
      const context = await setup();
      run = context.run;
      cleanup = context.cleanup;
    });

    afterEach(() => {
      cleanup();
    });

    test('cursor compare-and-set creates, advances, and rejects stale writers', async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* ServiceStatsStore;
          const base = {
            service: 'api',
            startedMs: NOW - HOUR_MS,
            nowMs: NOW,
            gap: null,
          };
          const created = yield* store.commitStep({
            ...base,
            expectedForwardMs: null,
            newForwardMs: NOW - 1000,
            traces: [trace('t1', NOW - 5000)],
          });
          const createdAgain = yield* store.commitStep({
            ...base,
            expectedForwardMs: null,
            newForwardMs: NOW - 500,
            traces: [trace('t-dup-create', NOW - 4000)],
          });
          const advanced = yield* store.commitStep({
            ...base,
            expectedForwardMs: NOW - 1000,
            newForwardMs: NOW,
            traces: [errorTrace('t2', NOW - 3000)],
          });
          const stale = yield* store.commitStep({
            ...base,
            expectedForwardMs: NOW - 1000,
            newForwardMs: NOW + 1000,
            traces: [errorTrace('t3', NOW - 2000)],
            gap: { startMs: NOW - 3000, endMs: NOW - 2000 },
          });
          return {
            created,
            createdAgain,
            advanced,
            stale,
            cursor: yield* store.getCursor('api'),
            cursors: yield* store.listCursors(),
            buckets: yield* minuteBuckets(),
            gaps: yield* store.readGaps({
              services: undefined,
              fromMs: 0,
              toMs: NOW * 2,
            }),
            errors: yield* store.recentErrorTraces({
              service: 'api',
              fromMs: 0,
              toMs: NOW * 2,
              limit: 10,
            }),
            // t3 was rolled back with the stale step, so it is still uncounted
            retried: yield* commit('api', [trace('t3', NOW - 2000)]),
            afterRetry: yield* minuteBuckets(),
          };
        }),
      );

      expect(result.created).toBe('committed');
      expect(result.createdAgain).toBe('conflict');
      expect(result.advanced).toBe('committed');
      expect(result.stale).toBe('conflict');
      expect(result.cursor).toEqual({
        startedMs: NOW - HOUR_MS,
        forwardMs: NOW,
      });
      expect(result.cursors).toEqual([
        { service: 'api', startedMs: NOW - HOUR_MS, forwardMs: NOW },
      ]);
      expect(result.buckets.reduce((sum, row) => sum + row.traceCount, 0)).toBe(
        2,
      );
      expect(result.gaps).toEqual([]);
      expect(result.errors.map((row) => row.traceId)).toEqual(['t2']);
      expect(result.retried).toBe('committed');
      expect(
        result.afterRetry.reduce((sum, row) => sum + row.traceCount, 0),
      ).toBe(3);
    });

    test('a trace already seen is not counted again across commits', async () => {
      const buckets = await run(
        Effect.gen(function* () {
          yield* commit('api', [
            trace('a', NOW - 5000),
            trace('b', NOW - 4000),
          ]);
          yield* commit('api', [
            trace('a', NOW - 5000),
            trace('c', NOW - 3000),
            trace('c', NOW - 3000),
          ]);
          return yield* minuteBuckets();
        }),
      );

      expect(buckets).toHaveLength(1);
      expect(buckets[0]?.traceCount).toBe(3);
    });

    test('a non-finite duration fails the commit with ServiceStatsStoreError and writes nothing', async () => {
      const result = await run(
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            commit('api', [
              trace('ok', NOW - 5000),
              trace('bad', NOW - 4000, { durationMs: Number.NaN }),
            ]),
          );
          const store = yield* ServiceStatsStore;
          return {
            failure,
            cursor: yield* store.getCursor('api'),
            buckets: yield* minuteBuckets(),
          };
        }),
      );

      expect(result.failure._tag).toBe('ServiceStatsStoreError');
      expect(result.cursor).toBeNull();
      expect(result.buckets).toEqual([]);
    });

    test('a long-running trace stays deduped after prune because seen rows age by counting time', async () => {
      const buckets = await run(
        Effect.gen(function* () {
          const store = yield* ServiceStatsStore;
          yield* commit('api', [trace('long', NOW - HOUR_MS)]);
          yield* commit('api', [], { newForwardMs: NOW + MINUTE_MS });
          yield* store.prune({
            nowMs: NOW,
            minuteRetentionMs: 26 * HOUR_MS,
            hourRetentionMs: 15 * DAY_MS,
          });
          yield* commit('api', [trace('long', NOW - HOUR_MS)], {
            newForwardMs: NOW + 2 * MINUTE_MS,
          });
          return yield* minuteBuckets();
        }),
      );

      expect(buckets.reduce((sum, row) => sum + row.traceCount, 0)).toBe(1);
    });

    test('merges counts and sketches into minute and hour rows', async () => {
      const minuteStart = NOW - 30 * MINUTE_MS;
      const first = [
        trace('a', minuteStart + 1000, { durationMs: 5 }),
        errorTrace('b', minuteStart + 2000),
      ];
      const second = [
        trace('c', minuteStart + 30_000, { durationMs: 500 }),
        trace('d', minuteStart + MINUTE_MS + 1000, { durationMs: 20 }),
      ];

      const result = await run(
        Effect.gen(function* () {
          const store = yield* ServiceStatsStore;
          yield* commit('api', first);
          yield* commit('api', second);
          yield* commit('worker', [trace('w', minuteStart + 3000)]);
          const read = (resolution: 'minute' | 'hour', services?: string[]) =>
            store.readBuckets({
              services,
              resolution,
              fromMs: NOW - 2 * HOUR_MS,
              toMs: NOW,
            });
          return {
            minutes: yield* read('minute', ['api']),
            hours: yield* read('hour', ['api']),
            allHours: yield* read('hour'),
            outside: yield* store.readBuckets({
              services: ['api'],
              resolution: 'minute',
              fromMs: minuteStart + 1,
              toMs: minuteStart + MINUTE_MS,
            }),
          };
        }),
      );

      expect(result.minutes.map((row) => row.bucketStart)).toEqual([
        minuteStart,
        minuteStart + MINUTE_MS,
      ]);
      expect(result.minutes[0]?.traceCount).toBe(3);
      expect(result.minutes[0]?.errorTraceCount).toBe(1);
      expect(result.minutes[1]?.traceCount).toBe(1);

      const hourStart = Math.floor(minuteStart / HOUR_MS) * HOUR_MS;
      expect(result.hours).toHaveLength(1);
      expect(result.hours[0]?.bucketStart).toBe(hourStart);
      expect(result.hours[0]?.traceCount).toBe(4);
      expect(result.hours[0]?.errorTraceCount).toBe(1);
      const expected = mergeSketches(
        sketchFromDurations([5, 10, 500]),
        sketchFromDurations([20]),
      );
      const hourSketch = result.hours[0]?.latency;
      expect(hourSketch).toEqual(expected);
      expect(sketchCount(hourSketch ?? new Map())).toBe(4);
      expect(quantile(hourSketch ?? new Map(), 1)).toBe(quantile(expected, 1));

      expect(result.allHours.map((row) => row.service).sort()).toEqual([
        'api',
        'worker',
      ]);
      // bucketStart is the filter column: a range starting inside the minute excludes it
      expect(result.outside).toEqual([]);
    });

    test('recentErrorTraces returns the newest first within the range', async () => {
      const rows = await run(
        Effect.gen(function* () {
          const store = yield* ServiceStatsStore;
          yield* commit('api', [
            errorTrace('e1', NOW - 5000),
            errorTrace('e2', NOW - 4000),
            errorTrace('e3', NOW - 3000),
            errorTrace('e4', NOW - 2000),
            trace('ok', NOW - 1000),
          ]);
          yield* commit('other', [errorTrace('o1', NOW - 3500)]);
          return {
            all: yield* store.recentErrorTraces({
              service: 'api',
              fromMs: 0,
              toMs: NOW,
              limit: 3,
            }),
            ranged: yield* store.recentErrorTraces({
              service: 'api',
              fromMs: NOW - 4000,
              toMs: NOW - 2000,
              limit: 10,
            }),
          };
        }),
      );

      expect(rows.all.map((row) => row.traceId)).toEqual(['e4', 'e3', 'e2']);
      expect(rows.ranged.map((row) => row.traceId)).toEqual(['e3', 'e2']);
      expect(rows.all[0]).toEqual({
        service: 'api',
        traceId: 'e4',
        startMs: NOW - 2000,
        rootService: 'gateway',
        rootOperation: 'GET /',
        spanCount: 3,
        errorSpanCount: 1,
        durationMs: 10,
      });
    });

    test('readGaps returns gaps overlapping the range', async () => {
      const gaps = await run(
        Effect.gen(function* () {
          const store = yield* ServiceStatsStore;
          yield* commit('api', [], {
            gap: { startMs: NOW - 100_000, endMs: NOW - 90_000 },
          });
          yield* commit('api', [], {
            gap: { startMs: NOW - 50_000, endMs: NOW - 40_000 },
          });
          yield* commit('other', [], {
            gap: { startMs: NOW - 50_000, endMs: NOW - 40_000 },
          });
          return {
            inside: yield* store.readGaps({
              services: ['api'],
              fromMs: NOW - 95_000,
              toMs: NOW - 45_000,
            }),
            touching: yield* store.readGaps({
              services: ['api'],
              fromMs: NOW - 90_000,
              toMs: NOW - 50_000,
            }),
            all: yield* store.readGaps({
              services: undefined,
              fromMs: NOW - 60_000,
              toMs: NOW,
            }),
          };
        }),
      );

      expect(gaps.inside).toEqual([
        { service: 'api', startMs: NOW - 100_000, endMs: NOW - 90_000 },
        { service: 'api', startMs: NOW - 50_000, endMs: NOW - 40_000 },
      ]);
      expect(gaps.touching).toEqual([]);
      expect(gaps.all.map((gap) => gap.service)).toEqual(['api', 'other']);
    });

    test('prune applies retention to buckets, gaps, seen rows and error traces', async () => {
      const minuteRetentionMs = 26 * HOUR_MS;
      const hourRetentionMs = 15 * DAY_MS;
      const recentMinute = NOW - 2 * HOUR_MS;
      const olderHour = NOW - 30 * HOUR_MS;

      const result = await run(
        Effect.gen(function* () {
          const store = yield* ServiceStatsStore;
          yield* commit('api', [trace('seen-old', NOW - 20 * MINUTE_MS)], {
            newForwardMs: NOW - 20 * MINUTE_MS,
          });
          yield* commit('api', [
            trace('past-minute', NOW - 27 * HOUR_MS),
            trace('past-hour', NOW - 16 * DAY_MS),
            trace('seen-recent', NOW - 5 * MINUTE_MS),
            ...Array.from({ length: 8 }, (_, i) =>
              errorTrace(`min-a-${i}`, recentMinute + i * 1000),
            ),
            ...Array.from({ length: 8 }, (_, i) =>
              errorTrace(`min-b-${i}`, recentMinute + MINUTE_MS + i * 1000),
            ),
            ...Array.from({ length: 8 }, (_, i) =>
              errorTrace(`hour-${i}`, olderHour + i * 20_000),
            ),
            errorTrace('too-old', NOW - 16 * DAY_MS),
          ]);
          yield* commit('api', [], {
            gap: {
              startMs: NOW - 16 * DAY_MS,
              endMs: NOW - 16 * DAY_MS + 5000,
            },
          });
          yield* commit('api', [], {
            gap: { startMs: NOW - HOUR_MS, endMs: NOW - HOUR_MS + 5000 },
          });

          yield* store.prune({
            nowMs: NOW,
            minuteRetentionMs,
            hourRetentionMs,
          });

          const range = { fromMs: 0, toMs: NOW * 2 };
          const recount = yield* commit('api', [
            trace('seen-old', NOW - 20 * MINUTE_MS),
            trace('seen-recent', NOW - 5 * MINUTE_MS),
          ]);
          return {
            recount,
            minute: yield* store.readBuckets({
              services: ['api'],
              resolution: 'minute',
              ...range,
            }),
            hour: yield* store.readBuckets({
              services: ['api'],
              resolution: 'hour',
              ...range,
            }),
            gaps: yield* store.readGaps({ services: undefined, ...range }),
            errors: yield* store.recentErrorTraces({
              service: 'api',
              limit: 100,
              ...range,
            }),
          };
        }),
      );

      expect(result.recount).toBe('committed');
      const minuteStarts = result.minute.map((row) => row.bucketStart);
      expect(minuteStarts).not.toContain(
        Math.floor((NOW - 27 * HOUR_MS) / MINUTE_MS) * MINUTE_MS,
      );
      expect(minuteStarts).toContain(
        Math.floor((NOW - 5 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS,
      );
      const hourStarts = result.hour.map((row) => row.bucketStart);
      expect(hourStarts).not.toContain(
        Math.floor((NOW - 16 * DAY_MS) / HOUR_MS) * HOUR_MS,
      );
      expect(hourStarts).toContain(
        Math.floor((NOW - 27 * HOUR_MS) / HOUR_MS) * HOUR_MS,
      );

      expect(result.gaps).toEqual([
        { service: 'api', startMs: NOW - HOUR_MS, endMs: NOW - HOUR_MS + 5000 },
      ]);

      // seen-old was pruned from `seen` so the recommit counts it again;
      // seen-recent stayed and was skipped.
      const recentMinuteRow = result.minute.find(
        (row) =>
          row.bucketStart ===
          Math.floor((NOW - 5 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS,
      );
      expect(recentMinuteRow?.traceCount).toBe(1);
      const oldMinuteRow = result.minute.find(
        (row) =>
          row.bucketStart ===
          Math.floor((NOW - 20 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS,
      );
      expect(oldMinuteRow?.traceCount).toBe(2);

      const ids = result.errors.map((row) => row.traceId).sort();
      const newest = (prefix: string, from: number, to: number) =>
        Array.from({ length: to - from }, (_, i) => `${prefix}-${from + i}`);
      expect(ids).toEqual(
        [
          ...newest('min-a', 2, 8),
          ...newest('min-b', 2, 8),
          ...newest('hour', 2, 8),
        ].sort(),
      );
    });
  });
}

storeSuite('SqliteServiceStatsStore', async () => {
  const dbPath = `/tmp/traces-service-stats-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
  const configLayer = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ TRACES_DB: dbPath }),
  );
  const layer = Layer.provide(
    Layer.provide(SqliteServiceStatsStoreLayer, SqliteDbLayer),
    configLayer,
  );
  return {
    run: (program) => Effect.runPromise(Effect.provide(program, layer)),
    cleanup: () => {
      try {
        unlinkSync(dbPath);
      } catch {
        // temp file may already be removed
      }
    },
  };
});

const databaseUrl = process.env.DATABASE_URL;

storeSuite(
  'PgServiceStatsStore',
  async () => {
    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ DATABASE_URL: databaseUrl }),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* PgDb;
          yield* db.execute(
            sql`TRUNCATE service_stat_buckets, service_stat_cursors, service_stat_gaps, service_stat_seen, service_error_traces`,
          );
        }),
        Layer.provide(PgDbLayer, configLayer),
      ),
    );
    const layer = Layer.provide(
      Layer.provide(PgServiceStatsStoreLayer, PgDbLayer),
      configLayer,
    );
    return {
      run: (program) => Effect.runPromise(Effect.provide(program, layer)),
      cleanup: () => {},
    };
  },
  databaseUrl === undefined,
);
