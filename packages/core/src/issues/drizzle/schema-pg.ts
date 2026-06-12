import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const issues = pgTable(
  'issues',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    fingerprint: text().notNull().unique(),
    title: text().notNull(),
    service: text().notNull(),
    exceptionType: text().notNull(),
    status: text({ enum: ['unresolved', 'resolved'] })
      .notNull()
      .$defaultFn(() => 'unresolved'),
    firstSeen: timestamp().notNull(),
    lastSeen: timestamp().notNull(),
    occurrenceCount: integer()
      .notNull()
      .$defaultFn(() => 0),
    resolvedAt: timestamp(),
  },
  (table) => [
    index('issues_status_idx').on(table.status),
    index('issues_service_idx').on(table.service),
    index('issues_last_seen_idx').on(table.lastSeen),
  ],
);

export const occurrences = pgTable(
  'occurrences',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    issueId: bigint({ mode: 'number' })
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    traceId: text().notNull(),
    spanId: text().notNull(),
    serviceName: text().notNull(),
    timestamp: timestamp().notNull(),
    exceptionMessage: text().notNull(),
    exceptionStacktrace: text(),
    attributes: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
  },
  (table) => [
    index('occurrences_issue_id_idx').on(table.issueId),
    index('occurrences_timestamp_idx').on(table.timestamp),
    index('occurrences_issue_span_idx').on(table.issueId, table.spanId),
  ],
);

export const ingestState = pgTable('ingest_state', {
  service: text().primaryKey(),
  cursorEnd: timestamp().notNull(),
  updatedAt: timestamp()
    .notNull()
    .$defaultFn(() => new Date()),
});

export const pgSchema = {
  issues,
  occurrences,
  ingestState,
};
