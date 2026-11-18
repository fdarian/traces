import {
  bigint,
  bigserial,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';

export const serviceStatBuckets = pgTable(
  'service_stat_buckets',
  {
    resolution: text({ enum: ['minute', 'hour'] }).notNull(),
    bucketStart: bigint({ mode: 'number' }).notNull(),
    service: text().notNull(),
    traceCount: integer().notNull(),
    errorTraceCount: integer().notNull(),
    latency: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.resolution, table.bucketStart, table.service],
    }),
  ],
);

export const serviceStatCursors = pgTable('service_stat_cursors', {
  service: text().primaryKey(),
  startedMs: bigint({ mode: 'number' }).notNull(),
  forwardMs: bigint({ mode: 'number' }).notNull(),
  updatedMs: bigint({ mode: 'number' }).notNull(),
});

export const serviceStatGaps = pgTable(
  'service_stat_gaps',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    service: text().notNull(),
    startMs: bigint({ mode: 'number' }).notNull(),
    endMs: bigint({ mode: 'number' }).notNull(),
  },
  (table) => [
    index('service_stat_gaps_service_end_idx').on(table.service, table.endMs),
  ],
);

export const serviceStatSeen = pgTable(
  'service_stat_seen',
  {
    service: text().notNull(),
    traceId: text().notNull(),
    startMs: bigint({ mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.service, table.traceId] }),
    index('service_stat_seen_start_idx').on(table.startMs),
  ],
);

export const serviceErrorTraces = pgTable(
  'service_error_traces',
  {
    service: text().notNull(),
    traceId: text().notNull(),
    startMs: bigint({ mode: 'number' }).notNull(),
    rootService: text().notNull(),
    rootOperation: text().notNull(),
    spanCount: integer().notNull(),
    errorSpanCount: integer().notNull(),
    durationMs: doublePrecision().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.service, table.traceId] }),
    index('service_error_traces_service_start_idx').on(
      table.service,
      table.startMs,
    ),
  ],
);

export const serviceStatsPgSchema = {
  serviceStatBuckets,
  serviceStatCursors,
  serviceStatGaps,
  serviceStatSeen,
  serviceErrorTraces,
};
