import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const issues = sqliteTable(
  'issues',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    fingerprint: text().notNull().unique(),
    title: text().notNull(),
    service: text().notNull(),
    exceptionType: text().notNull(),
    status: text({ enum: ['unresolved', 'resolved'] })
      .notNull()
      .$defaultFn(() => 'unresolved'),
    firstSeen: integer({ mode: 'timestamp_ms' }).notNull(),
    lastSeen: integer({ mode: 'timestamp_ms' }).notNull(),
    occurrenceCount: integer()
      .notNull()
      .$defaultFn(() => 0),
    resolvedAt: integer({ mode: 'timestamp_ms' }),
  },
  (table) => [
    index('issues_status_idx').on(table.status),
    index('issues_service_idx').on(table.service),
    index('issues_last_seen_idx').on(table.lastSeen),
  ],
);

export const occurrences = sqliteTable(
  'occurrences',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    issueId: integer()
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    traceId: text().notNull(),
    spanId: text().notNull(),
    serviceName: text().notNull(),
    timestamp: integer({ mode: 'timestamp_ms' }).notNull(),
    exceptionMessage: text().notNull(),
    exceptionStacktrace: text(),
    attributes: text({ mode: 'json' })
      .notNull()
      .$defaultFn(() => ({})),
  },
  (table) => [
    index('occurrences_issue_id_idx').on(table.issueId),
    index('occurrences_timestamp_idx').on(table.timestamp),
    uniqueIndex('occurrences_issue_span_unique').on(
      table.issueId,
      table.spanId,
    ),
  ],
);

export const ingestState = sqliteTable('ingest_state', {
  service: text().primaryKey(),
  cursorEnd: integer({ mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sqliteSchema = {
  issues,
  occurrences,
  ingestState,
};
