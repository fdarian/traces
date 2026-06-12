import { fileURLToPath } from 'node:url';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { Config, Effect, Layer, Schema } from 'effect';
import postgres from 'postgres';
import { pgSchema } from './drizzle/schema-pg.js';
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
  new URL('../../drizzle/pg', import.meta.url),
);

function wrapStoreError<A>(
  fn: () => Promise<A>,
): Effect.Effect<A, IssueStoreError, never> {
  return Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new IssueStoreError({
        cause: Schema.decodeUnknownSync(Schema.Defect)(cause),
      }),
  });
}

function makePgStore(db: ReturnType<typeof drizzle>) {
  const upsertOccurrence = (
    input: UpsertOccurrenceInput,
  ): Effect.Effect<void, IssueStoreError, never> => {
    return Effect.gen(function* () {
      const timestamp = new Date(input.timestamp);
      const stacktrace = input.exceptionStacktrace;

      const result = yield* wrapStoreError(
        (): Promise<UpsertTransactionResult> =>
          db.transaction(async (tx): Promise<UpsertTransactionResult> => {
            const existingIssues = await tx
              .select()
              .from(pgSchema.issues)
              .where(eq(pgSchema.issues.fingerprint, input.fingerprint));

            let issueId: number;
            const existingIssue = existingIssues[0];
            if (existingIssue === undefined) {
              const inserted = await tx
                .insert(pgSchema.issues)
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
                .returning({ id: pgSchema.issues.id });
              const row = inserted[0];
              if (row === undefined) {
                return 'insert-failed';
              }
              issueId = row.id;
            } else {
              issueId = existingIssue.id;
            }

            const insertedOccurrences = await tx
              .insert(pgSchema.occurrences)
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
                  pgSchema.occurrences.issueId,
                  pgSchema.occurrences.spanId,
                ],
              })
              .returning({ id: pgSchema.occurrences.id });

            if (insertedOccurrences.length === 0) {
              return 'deduped';
            }

            const issueRows = await tx
              .select()
              .from(pgSchema.issues)
              .where(eq(pgSchema.issues.id, issueId));
            const issueRow = issueRows[0];
            if (issueRow === undefined) {
              return 'missing-issue';
            }

            const nextCount = issueRow.occurrenceCount + 1;
            const nextStatus =
              issueRow.status === 'resolved' ? 'unresolved' : issueRow.status;
            const nextLastSeen = maxTimestamp(issueRow.lastSeen, timestamp);

            await tx
              .update(pgSchema.issues)
              .set({
                lastSeen: nextLastSeen,
                occurrenceCount: nextCount,
                status: nextStatus,
                resolvedAt:
                  nextStatus === 'unresolved' ? null : issueRow.resolvedAt,
              })
              .where(eq(pgSchema.issues.id, issueId));

            // Retention keeps the latest rows; occurrenceCount stays lifetime total.
            const overflow = nextCount - MAX_OCCURRENCES_PER_ISSUE;
            if (overflow > 0) {
              const staleRows = await tx
                .select({ id: pgSchema.occurrences.id })
                .from(pgSchema.occurrences)
                .where(eq(pgSchema.occurrences.issueId, issueId))
                .orderBy(desc(pgSchema.occurrences.timestamp))
                .offset(MAX_OCCURRENCES_PER_ISSUE);

              for (const stale of staleRows) {
                await tx
                  .delete(pgSchema.occurrences)
                  .where(eq(pgSchema.occurrences.id, stale.id));
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
          .select({ id: pgSchema.issues.id })
          .from(pgSchema.issues)
          .where(eq(pgSchema.issues.id, issueId)),
      );
      if (rows.length === 0) {
        return yield* Effect.fail(new IssueNotFound({ issueId }));
      }

      const now = new Date();
      yield* wrapStoreError(() =>
        db
          .update(pgSchema.issues)
          .set({
            status: 'resolved',
            resolvedAt: now,
          })
          .where(eq(pgSchema.issues.id, issueId)),
      );
    });
  };

  const unresolveIssue = (
    issueId: number,
  ): Effect.Effect<void, IssueStoreError | IssueNotFound, never> => {
    return Effect.gen(function* () {
      const rows = yield* wrapStoreError(() =>
        db
          .select({ id: pgSchema.issues.id })
          .from(pgSchema.issues)
          .where(eq(pgSchema.issues.id, issueId)),
      );
      if (rows.length === 0) {
        return yield* Effect.fail(new IssueNotFound({ issueId }));
      }

      yield* wrapStoreError(() =>
        db
          .update(pgSchema.issues)
          .set({
            status: 'unresolved',
            resolvedAt: null,
          })
          .where(eq(pgSchema.issues.id, issueId)),
      );
    });
  };

  const listIssues = (
    filter: ListIssuesFilter,
  ): Effect.Effect<ReadonlyArray<Issue>, IssueStoreError, never> => {
    return Effect.gen(function* () {
      const rows = yield* wrapStoreError(() => {
        const conditions = [];
        if (filter.status !== undefined) {
          conditions.push(eq(pgSchema.issues.status, filter.status));
        }
        if (filter.service !== undefined) {
          conditions.push(eq(pgSchema.issues.service, filter.service));
        }

        let query = db.select().from(pgSchema.issues).$dynamic();
        if (conditions.length === 1) {
          query = query.where(conditions[0]);
        } else if (conditions.length === 2) {
          query = query.where(and(conditions[0], conditions[1]));
        }
        return query.orderBy(desc(pgSchema.issues.lastSeen));
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
          .from(pgSchema.issues)
          .where(eq(pgSchema.issues.id, issueId)),
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
          .from(pgSchema.occurrences)
          .where(eq(pgSchema.occurrences.issueId, issueId))
          .orderBy(desc(pgSchema.occurrences.timestamp)),
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
          .from(pgSchema.ingestState)
          .where(eq(pgSchema.ingestState.service, service)),
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
    return wrapStoreError(() =>
      db
        .insert(pgSchema.ingestState)
        .values({
          service,
          cursorEnd,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: pgSchema.ingestState.service,
          set: {
            cursorEnd,
            updatedAt: new Date(),
          },
        }),
    );
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

export const PgIssueStoreLayer = Layer.scoped(
  IssueStore,
  Effect.gen(function* () {
    const databaseUrl = yield* Config.string('DATABASE_URL');
    const sql = yield* Effect.acquireRelease(
      Effect.sync(() => postgres(databaseUrl, { max: 1 })),
      (client) =>
        Effect.sync(() => {
          client.end({ timeout: 0 });
        }),
    );
    const db = drizzle(sql, { schema: pgSchema });
    yield* wrapStoreError(() => migrate(db, { migrationsFolder }));
    return makePgStore(db);
  }),
);
