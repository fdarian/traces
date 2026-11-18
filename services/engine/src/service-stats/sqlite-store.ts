import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  type SQL,
  sql,
} from 'drizzle-orm';
import { Effect, Layer } from 'effect';
import { SqliteDb } from '#/db/sqlite';
import { serviceStatsSqliteSchema } from '#/service-stats/drizzle/schema-sqlite';
import {
  type CommitStepInput,
  HOUR_MS,
  MINUTE_MS,
  SEEN_RETENTION_MS,
  ServiceStatsStore,
  type StatsBucket,
} from '#/service-stats/store';
import {
  aggregateBuckets,
  chunk,
  decodeLatency,
  errorTraceRows,
  excluded,
  mergeBucket,
  rankedErrorTraceDelete,
  StepConflict,
  uniqueByTraceId,
  WRITE_CHUNK,
  wrapStoreError,
} from '#/service-stats/store-helpers';

const schema = serviceStatsSqliteSchema;

function makeSqliteStatsStore(db: SqliteDb) {
  const listCursors = () =>
    wrapStoreError(
      db
        .select({
          service: schema.serviceStatCursors.service,
          startedMs: schema.serviceStatCursors.startedMs,
          forwardMs: schema.serviceStatCursors.forwardMs,
        })
        .from(schema.serviceStatCursors),
    );

  const getCursor = (service: string) =>
    Effect.gen(function* () {
      const rows = yield* wrapStoreError(
        db
          .select({
            startedMs: schema.serviceStatCursors.startedMs,
            forwardMs: schema.serviceStatCursors.forwardMs,
          })
          .from(schema.serviceStatCursors)
          .where(eq(schema.serviceStatCursors.service, service)),
      );
      return rows[0] ?? null;
    });

  const commitStep = (input: CommitStepInput) =>
    wrapStoreError(
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (input.expectedForwardMs === null) {
              const inserted = yield* tx
                .insert(schema.serviceStatCursors)
                .values({
                  service: input.service,
                  startedMs: input.startedMs,
                  forwardMs: input.newForwardMs,
                  updatedMs: input.nowMs,
                })
                .onConflictDoNothing()
                .returning({ service: schema.serviceStatCursors.service });
              if (inserted.length === 0) {
                return yield* new StepConflict();
              }
            } else {
              const updated = yield* tx
                .update(schema.serviceStatCursors)
                .set({
                  forwardMs: input.newForwardMs,
                  updatedMs: input.nowMs,
                })
                .where(
                  and(
                    eq(schema.serviceStatCursors.service, input.service),
                    eq(
                      schema.serviceStatCursors.forwardMs,
                      input.expectedForwardMs,
                    ),
                  ),
                )
                .returning({ service: schema.serviceStatCursors.service });
              if (updated.length === 0) {
                return yield* new StepConflict();
              }
            }

            const fresh = new Set<string>();
            for (const batch of chunk(
              uniqueByTraceId(input.traces),
              WRITE_CHUNK,
            )) {
              const inserted = yield* tx
                .insert(schema.serviceStatSeen)
                .values(
                  batch.map((trace) => ({
                    service: input.service,
                    traceId: trace.traceId,
                    startMs: trace.startMs,
                  })),
                )
                .onConflictDoNothing()
                .returning({ traceId: schema.serviceStatSeen.traceId });
              for (const row of inserted) {
                fresh.add(row.traceId);
              }
            }
            const counted = uniqueByTraceId(input.traces).filter((trace) =>
              fresh.has(trace.traceId),
            );

            for (const delta of aggregateBuckets(counted)) {
              const existingRows = yield* tx
                .select({
                  traceCount: schema.serviceStatBuckets.traceCount,
                  errorTraceCount: schema.serviceStatBuckets.errorTraceCount,
                  latency: schema.serviceStatBuckets.latency,
                })
                .from(schema.serviceStatBuckets)
                .where(
                  and(
                    eq(schema.serviceStatBuckets.resolution, delta.resolution),
                    eq(
                      schema.serviceStatBuckets.bucketStart,
                      delta.bucketStart,
                    ),
                    eq(schema.serviceStatBuckets.service, input.service),
                  ),
                );
              const merged = yield* mergeBucket(delta, existingRows[0]);
              yield* tx
                .insert(schema.serviceStatBuckets)
                .values({
                  resolution: delta.resolution,
                  bucketStart: delta.bucketStart,
                  service: input.service,
                  ...merged,
                })
                .onConflictDoUpdate({
                  target: [
                    schema.serviceStatBuckets.resolution,
                    schema.serviceStatBuckets.bucketStart,
                    schema.serviceStatBuckets.service,
                  ],
                  set: merged,
                });
            }

            for (const batch of chunk(
              errorTraceRows(input.service, counted),
              WRITE_CHUNK,
            )) {
              yield* tx
                .insert(schema.serviceErrorTraces)
                .values([...batch])
                .onConflictDoUpdate({
                  target: [
                    schema.serviceErrorTraces.service,
                    schema.serviceErrorTraces.traceId,
                  ],
                  set: {
                    startMs: excluded(schema.serviceErrorTraces.startMs),
                    rootService: excluded(
                      schema.serviceErrorTraces.rootService,
                    ),
                    rootOperation: excluded(
                      schema.serviceErrorTraces.rootOperation,
                    ),
                    spanCount: excluded(schema.serviceErrorTraces.spanCount),
                    errorSpanCount: excluded(
                      schema.serviceErrorTraces.errorSpanCount,
                    ),
                    durationMs: excluded(schema.serviceErrorTraces.durationMs),
                  },
                });
            }

            if (input.gap !== null) {
              yield* tx.insert(schema.serviceStatGaps).values({
                service: input.service,
                startMs: input.gap.startMs,
                endMs: input.gap.endMs,
              });
            }
          }),
        )
        .pipe(
          Effect.as('committed' as const),
          Effect.catchTag('StepConflict', () =>
            Effect.succeed('conflict' as const),
          ),
        ),
    );

  const readBuckets = (input: {
    readonly services: ReadonlyArray<string> | undefined;
    readonly resolution: 'minute' | 'hour';
    readonly fromMs: number;
    readonly toMs: number;
  }) =>
    Effect.gen(function* () {
      const conditions: Array<SQL | undefined> = [
        eq(schema.serviceStatBuckets.resolution, input.resolution),
        gte(schema.serviceStatBuckets.bucketStart, input.fromMs),
        lt(schema.serviceStatBuckets.bucketStart, input.toMs),
      ];
      if (input.services !== undefined && input.services.length > 0) {
        conditions.push(
          inArray(schema.serviceStatBuckets.service, [...input.services]),
        );
      }
      const rows = yield* wrapStoreError(
        db
          .select()
          .from(schema.serviceStatBuckets)
          .where(and(...conditions))
          .orderBy(
            schema.serviceStatBuckets.bucketStart,
            schema.serviceStatBuckets.service,
          ),
      );
      return yield* Effect.forEach(rows, (row) =>
        Effect.map(
          decodeLatency(row.latency),
          (latency): StatsBucket => ({ ...row, latency }),
        ),
      );
    });

  const readGaps = (input: {
    readonly services: ReadonlyArray<string> | undefined;
    readonly fromMs: number;
    readonly toMs: number;
  }) => {
    const conditions: Array<SQL | undefined> = [
      lt(schema.serviceStatGaps.startMs, input.toMs),
      gt(schema.serviceStatGaps.endMs, input.fromMs),
    ];
    if (input.services !== undefined && input.services.length > 0) {
      conditions.push(
        inArray(schema.serviceStatGaps.service, [...input.services]),
      );
    }
    return wrapStoreError(
      db
        .select({
          service: schema.serviceStatGaps.service,
          startMs: schema.serviceStatGaps.startMs,
          endMs: schema.serviceStatGaps.endMs,
        })
        .from(schema.serviceStatGaps)
        .where(and(...conditions))
        .orderBy(
          schema.serviceStatGaps.service,
          schema.serviceStatGaps.startMs,
        ),
    );
  };

  const recentErrorTraces = (input: {
    readonly service: string;
    readonly fromMs: number;
    readonly toMs: number;
    readonly limit: number;
  }) =>
    wrapStoreError(
      db
        .select()
        .from(schema.serviceErrorTraces)
        .where(
          and(
            eq(schema.serviceErrorTraces.service, input.service),
            gte(schema.serviceErrorTraces.startMs, input.fromMs),
            lt(schema.serviceErrorTraces.startMs, input.toMs),
          ),
        )
        .orderBy(
          desc(schema.serviceErrorTraces.startMs),
          desc(schema.serviceErrorTraces.traceId),
        )
        .limit(input.limit),
    );

  const prune = (input: {
    readonly nowMs: number;
    readonly minuteRetentionMs: number;
    readonly hourRetentionMs: number;
  }) => {
    const minuteCutoff = input.nowMs - input.minuteRetentionMs;
    const hourCutoff = input.nowMs - input.hourRetentionMs;
    const errorTraces = schema.serviceErrorTraces;
    return wrapStoreError(
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .delete(schema.serviceStatBuckets)
            .where(
              and(
                eq(schema.serviceStatBuckets.resolution, 'minute'),
                lt(schema.serviceStatBuckets.bucketStart, minuteCutoff),
              ),
            );
          yield* tx
            .delete(schema.serviceStatBuckets)
            .where(
              and(
                eq(schema.serviceStatBuckets.resolution, 'hour'),
                lt(schema.serviceStatBuckets.bucketStart, hourCutoff),
              ),
            );
          yield* tx
            .delete(schema.serviceStatGaps)
            .where(lt(schema.serviceStatGaps.endMs, hourCutoff));
          yield* tx
            .delete(schema.serviceStatSeen)
            .where(
              lt(
                schema.serviceStatSeen.startMs,
                sql`(SELECT ${schema.serviceStatCursors.forwardMs} - ${SEEN_RETENTION_MS} FROM ${schema.serviceStatCursors} WHERE ${schema.serviceStatCursors.service} = ${schema.serviceStatSeen.service})`,
              ),
            );
          yield* tx
            .delete(errorTraces)
            .where(lt(errorTraces.startMs, hourCutoff));
          yield* tx.run(
            rankedErrorTraceDelete({
              table: 'service_error_traces',
              bucketMs: MINUTE_MS,
              rangeCondition: sql`"startMs" >= ${minuteCutoff}`,
            }),
          );
          yield* tx.run(
            rankedErrorTraceDelete({
              table: 'service_error_traces',
              bucketMs: HOUR_MS,
              rangeCondition: sql`"startMs" < ${minuteCutoff}`,
            }),
          );
        }),
      ),
    ).pipe(Effect.asVoid);
  };

  return {
    listCursors,
    getCursor,
    commitStep,
    readBuckets,
    readGaps,
    recentErrorTraces,
    prune,
  };
}

export const SqliteServiceStatsStoreLayer = Layer.effect(
  ServiceStatsStore,
  Effect.gen(function* () {
    const db = yield* SqliteDb;
    return makeSqliteStatsStore(db);
  }),
);
