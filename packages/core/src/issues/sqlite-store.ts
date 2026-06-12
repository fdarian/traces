import { Database } from 'bun:sqlite';
import { fileURLToPath } from 'node:url';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { Config, Effect, Layer, Schema } from 'effect';
import { sqliteSchema } from './drizzle/schema-sqlite.js';
import { IssueNotFound, IssueStoreError } from './errors.js';
import { mapIssueRow, mapOccurrenceRow } from './map-row.js';
import type {
  Issue,
  ListIssuesFilter,
  Occurrence,
  UpsertOccurrenceInput,
} from './model.js';
import { IssueStore, MAX_OCCURRENCES_PER_ISSUE } from './store.js';
import { issueStoreDefect, maxTimestamp } from './store-helpers.js';

type UpsertTransactionResult =
  | 'deduped'
  | 'inserted'
  | 'insert-failed'
  | 'missing-issue';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle/sqlite', import.meta.url),
);

function wrapStoreError<A>(
  fn: () => A,
): Effect.Effect<A, IssueStoreError, never> {
  return Effect.try({
    try: fn,
    catch: (cause) =>
      new IssueStoreError({
        cause: Schema.decodeUnknownSync(Schema.Defect)(cause),
      }),
  });
}

function makeSqliteStore(db: ReturnType<typeof drizzle>) {
  const upsertOccurrence = (
    input: UpsertOccurrenceInput,
  ): Effect.Effect<void, IssueStoreError, never> => {
    return Effect.gen(function* () {
      const timestamp = new Date(input.timestamp);
      const stacktrace = input.exceptionStacktrace;

      const result = yield* wrapStoreError(() =>
        db.transaction((tx): UpsertTransactionResult => {
          const existingIssues = tx
            .select()
            .from(sqliteSchema.issues)
            .where(eq(sqliteSchema.issues.fingerprint, input.fingerprint))
            .all();

          let issueId: number;
          const existingIssue = existingIssues[0];
          if (existingIssue === undefined) {
            const inserted = tx
              .insert(sqliteSchema.issues)
              .values({
                fingerprint: input.fingerprint,
                title: input.title,
                service: input.service,
                exceptionType: input.exceptionType,
                status: 'unresolved',
                firstSeen: timestamp,
                lastSeen: timestamp,
                occurrenceCount: 0,
                resolvedAt: null,
              })
              .returning({ id: sqliteSchema.issues.id })
              .all();
            const row = inserted[0];
            if (row === undefined) {
              return 'insert-failed';
            }
            issueId = row.id;
          } else {
            issueId = existingIssue.id;
          }

          const insertedOccurrences = tx
            .insert(sqliteSchema.occurrences)
            .values({
              issueId,
              traceId: input.traceId,
              spanId: input.spanId,
              serviceName: input.serviceName,
              timestamp,
              exceptionMessage: input.exceptionMessage,
              exceptionStacktrace: stacktrace,
              attributes: input.attributes,
            })
            .onConflictDoNothing({
              target: [
                sqliteSchema.occurrences.issueId,
                sqliteSchema.occurrences.traceId,
                sqliteSchema.occurrences.spanId,
              ],
            })
            .returning({ id: sqliteSchema.occurrences.id })
            .all();

          if (insertedOccurrences.length === 0) {
            return 'deduped';
          }

          const issueRows = tx
            .select()
            .from(sqliteSchema.issues)
            .where(eq(sqliteSchema.issues.id, issueId))
            .all();
          const issueRow = issueRows[0];
          if (issueRow === undefined) {
            return 'missing-issue';
          }

          const nextCount = issueRow.occurrenceCount + 1;
          const nextStatus =
            issueRow.status === 'resolved' ? 'unresolved' : issueRow.status;
          const nextLastSeen = maxTimestamp(issueRow.lastSeen, timestamp);

          tx.update(sqliteSchema.issues)
            .set({
              lastSeen: nextLastSeen,
              occurrenceCount: nextCount,
              status: nextStatus,
              resolvedAt:
                nextStatus === 'unresolved' ? null : issueRow.resolvedAt,
            })
            .where(eq(sqliteSchema.issues.id, issueId))
            .run();

          // Retention keeps the latest rows; occurrenceCount stays lifetime total.
          const overflow = nextCount - MAX_OCCURRENCES_PER_ISSUE;
          if (overflow > 0) {
            const staleRows = tx
              .select({ id: sqliteSchema.occurrences.id })
              .from(sqliteSchema.occurrences)
              .where(eq(sqliteSchema.occurrences.issueId, issueId))
              .orderBy(desc(sqliteSchema.occurrences.timestamp))
              .offset(MAX_OCCURRENCES_PER_ISSUE)
              .all();

            for (const stale of staleRows) {
              tx.delete(sqliteSchema.occurrences)
                .where(eq(sqliteSchema.occurrences.id, stale.id))
                .run();
            }
          }

          return 'inserted';
        }),
      );

      if (result === 'insert-failed') {
        return yield* Effect.fail(
          issueStoreDefect('failed to insert issue row'),
        );
      }
      if (result === 'missing-issue') {
        return yield* Effect.fail(
          issueStoreDefect('issue row missing after occurrence insert'),
        );
      }
    });
  };

  const resolveIssue = (
    issueId: number,
  ): Effect.Effect<void, IssueStoreError | IssueNotFound, never> => {
    return Effect.gen(function* () {
      const rows = yield* wrapStoreError(() =>
        db
          .select({ id: sqliteSchema.issues.id })
          .from(sqliteSchema.issues)
          .where(eq(sqliteSchema.issues.id, issueId))
          .all(),
      );
      if (rows.length === 0) {
        return yield* Effect.fail(new IssueNotFound({ issueId }));
      }

      const now = new Date();
      yield* wrapStoreError(() => {
        db.update(sqliteSchema.issues)
          .set({
            status: 'resolved',
            resolvedAt: now,
          })
          .where(eq(sqliteSchema.issues.id, issueId))
          .run();
      });
    });
  };

  const unresolveIssue = (
    issueId: number,
  ): Effect.Effect<void, IssueStoreError | IssueNotFound, never> => {
    return Effect.gen(function* () {
      const rows = yield* wrapStoreError(() =>
        db
          .select({ id: sqliteSchema.issues.id })
          .from(sqliteSchema.issues)
          .where(eq(sqliteSchema.issues.id, issueId))
          .all(),
      );
      if (rows.length === 0) {
        return yield* Effect.fail(new IssueNotFound({ issueId }));
      }

      yield* wrapStoreError(() => {
        db.update(sqliteSchema.issues)
          .set({
            status: 'unresolved',
            resolvedAt: null,
          })
          .where(eq(sqliteSchema.issues.id, issueId))
          .run();
      });
    });
  };

  const listIssues = (
    filter: ListIssuesFilter,
  ): Effect.Effect<ReadonlyArray<Issue>, IssueStoreError, never> => {
    return Effect.gen(function* () {
      const rows = yield* wrapStoreError(() => {
        const conditions = [];
        if (filter.status !== undefined) {
          conditions.push(eq(sqliteSchema.issues.status, filter.status));
        }
        if (filter.service !== undefined) {
          conditions.push(eq(sqliteSchema.issues.service, filter.service));
        }

        let query = db.select().from(sqliteSchema.issues).$dynamic();
        if (conditions.length === 1) {
          query = query.where(conditions[0]);
        } else if (conditions.length === 2) {
          query = query.where(and(conditions[0], conditions[1]));
        }
        return query.orderBy(desc(sqliteSchema.issues.lastSeen)).all();
      });

      const result: Array<Issue> = [];
      for (const row of rows) {
        result.push(
          mapIssueRow({
            id: row.id,
            fingerprint: row.fingerprint,
            title: row.title,
            service: row.service,
            exceptionType: row.exceptionType,
            status: row.status,
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen,
            occurrenceCount: row.occurrenceCount,
            resolvedAt: row.resolvedAt ?? null,
          }),
        );
      }
      return result;
    });
  };

  const getIssue = (
    issueId: number,
  ): Effect.Effect<Issue, IssueStoreError | IssueNotFound, never> => {
    return Effect.gen(function* () {
      const rows = yield* wrapStoreError(() =>
        db
          .select()
          .from(sqliteSchema.issues)
          .where(eq(sqliteSchema.issues.id, issueId))
          .all(),
      );
      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.fail(new IssueNotFound({ issueId }));
      }
      return mapIssueRow({
        id: row.id,
        fingerprint: row.fingerprint,
        title: row.title,
        service: row.service,
        exceptionType: row.exceptionType,
        status: row.status,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        occurrenceCount: row.occurrenceCount,
        resolvedAt: row.resolvedAt ?? null,
      });
    });
  };

  const getIssueOccurrences = (
    issueId: number,
  ): Effect.Effect<ReadonlyArray<Occurrence>, IssueStoreError, never> => {
    return Effect.gen(function* () {
      const rows = yield* wrapStoreError(() =>
        db
          .select()
          .from(sqliteSchema.occurrences)
          .where(eq(sqliteSchema.occurrences.issueId, issueId))
          .orderBy(desc(sqliteSchema.occurrences.timestamp))
          .all(),
      );

      const result: Array<Occurrence> = [];
      for (const row of rows) {
        const attributes =
          typeof row.attributes === 'object' && row.attributes !== null
            ? (row.attributes as Record<string, unknown>)
            : {};
        result.push(
          mapOccurrenceRow({
            id: row.id,
            issueId: row.issueId,
            traceId: row.traceId,
            spanId: row.spanId,
            serviceName: row.serviceName,
            timestamp: row.timestamp,
            exceptionMessage: row.exceptionMessage,
            exceptionStacktrace: row.exceptionStacktrace ?? null,
            attributes,
          }),
        );
      }
      return result;
    });
  };

  const getIngestCursor = (
    service: string,
  ): Effect.Effect<Date | null, IssueStoreError, never> => {
    return Effect.gen(function* () {
      const rows = yield* wrapStoreError(() =>
        db
          .select()
          .from(sqliteSchema.ingestState)
          .where(eq(sqliteSchema.ingestState.service, service))
          .all(),
      );
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return row.cursorEnd;
    });
  };

  const setIngestCursor = (
    service: string,
    cursorEnd: Date,
  ): Effect.Effect<void, IssueStoreError, never> => {
    return wrapStoreError(() => {
      db.insert(sqliteSchema.ingestState)
        .values({
          service,
          cursorEnd,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: sqliteSchema.ingestState.service,
          set: {
            cursorEnd,
            updatedAt: new Date(),
          },
        })
        .run();
    });
  };

  return {
    upsertOccurrence,
    resolveIssue,
    unresolveIssue,
    listIssues,
    getIssue,
    getIssueOccurrences,
    getIngestCursor,
    setIngestCursor,
  };
}

export const SqliteIssueStoreLayer = Layer.scoped(
  IssueStore,
  Effect.gen(function* () {
    const dbPath = yield* Config.string('TRACES_DB').pipe(
      Config.withDefault('./traces.db'),
    );
    const sqlite = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(dbPath)),
      (database) =>
        Effect.sync(() => {
          database.close();
        }),
    );
    const db = drizzle(sqlite, { schema: sqliteSchema });
    yield* wrapStoreError(() => {
      migrate(db, { migrationsFolder });
    });
    return makeSqliteStore(db);
  }),
);
