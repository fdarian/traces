import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const serviceStatBuckets = sqliteTable(
  'service_stat_buckets',
  {
    resolution: text({ enum: ['minute', 'hour'] }).notNull(),
    bucketStart: integer().notNull(),
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

export const serviceStatCursors = sqliteTable('service_stat_cursors', {
  service: text().primaryKey(),
  startedMs: integer().notNull(),
  forwardMs: integer().notNull(),
  updatedMs: integer().notNull(),
});

export const serviceStatGaps = sqliteTable(
  'service_stat_gaps',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    service: text().notNull(),
    startMs: integer().notNull(),
    endMs: integer().notNull(),
  },
  (table) => [
    index('service_stat_gaps_service_end_idx').on(table.service, table.endMs),
  ],
);

export const serviceStatSeen = sqliteTable(
  'service_stat_seen',
  {
    service: text().notNull(),
    traceId: text().notNull(),
    startMs: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.service, table.traceId] }),
    index('service_stat_seen_start_idx').on(table.startMs),
  ],
);

export const serviceErrorTraces = sqliteTable(
  'service_error_traces',
  {
    service: text().notNull(),
    traceId: text().notNull(),
    startMs: integer().notNull(),
    rootService: text().notNull(),
    rootOperation: text().notNull(),
    spanCount: integer().notNull(),
    errorSpanCount: integer().notNull(),
    durationMs: real().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.service, table.traceId] }),
    index('service_error_traces_service_start_idx').on(
      table.service,
      table.startMs,
    ),
  ],
);

export const serviceStatsSqliteSchema = {
  serviceStatBuckets,
  serviceStatCursors,
  serviceStatGaps,
  serviceStatSeen,
  serviceErrorTraces,
};
