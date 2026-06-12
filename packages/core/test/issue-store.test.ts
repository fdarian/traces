import { afterEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { ConfigProvider, Effect, Layer } from 'effect';
import { SqliteIssueStoreLayer } from '#/issues/sqlite-store.js';
import { IssueStore } from '#/issues/store.js';

function tempDbPath(): string {
  return `/tmp/traces-issue-store-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
}

function runStore<A, E>(
  dbPath: string,
  program: Effect.Effect<A, E, IssueStore>,
): Promise<A> {
  const configLayer = Layer.setConfigProvider(
    ConfigProvider.fromMap(new Map([['TRACES_DB', dbPath]])),
  );
  const layer = Layer.provide(SqliteIssueStoreLayer, configLayer);
  return Effect.runPromise(Effect.provide(program, layer));
}

describe('SqliteIssueStore', () => {
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

  test('upsert grows occurrence count and resolve/reopen regression works', async () => {
    dbPath = tempDbPath();

    const first = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        yield* store.upsertOccurrence({
          fingerprint: 'fp-regression',
          title: 'DatabaseConnectionError: connection refused',
          service: 'db',
          exceptionType: 'DatabaseConnectionError',
          traceId: 'trace-a',
          spanId: 'span-a',
          serviceName: 'db',
          timestamp: Date.now(),
          exceptionMessage: 'connection refused to postgres:5432',
          exceptionStacktrace:
            'DatabaseConnectionError: connection refused\n    at select (/app/db/src/index.ts:42:15)',
          attributes: { operation: 'select' },
        });
        return yield* store.listIssues({});
      }),
    );

    expect(first.length).toBe(1);
    expect(first[0].occurrenceCount).toBe(1);
    expect(first[0].status).toBe('unresolved');

    const issueId = first[0].id;

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        yield* store.upsertOccurrence({
          fingerprint: 'fp-regression',
          title: 'DatabaseConnectionError: connection refused',
          service: 'db',
          exceptionType: 'DatabaseConnectionError',
          traceId: 'trace-b',
          spanId: 'span-b',
          serviceName: 'db',
          timestamp: Date.now() + 1,
          exceptionMessage: 'connection refused to postgres:5432',
          attributes: { operation: 'select' },
        });
      }),
    );

    const afterSecond = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getIssue(issueId);
      }),
    );
    expect(afterSecond.occurrenceCount).toBe(2);

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        yield* store.resolveIssue(issueId);
      }),
    );

    const resolved = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getIssue(issueId);
      }),
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).not.toBeNull();

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        yield* store.upsertOccurrence({
          fingerprint: 'fp-regression',
          title: 'DatabaseConnectionError: connection refused',
          service: 'db',
          exceptionType: 'DatabaseConnectionError',
          traceId: 'trace-c',
          spanId: 'span-c',
          serviceName: 'db',
          timestamp: Date.now() + 2,
          exceptionMessage: 'connection refused to postgres:5432',
          attributes: { operation: 'select' },
        });
      }),
    );

    const reopened = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getIssue(issueId);
      }),
    );
    expect(reopened.status).toBe('unresolved');
    expect(reopened.resolvedAt).not.toBeNull();
    expect(reopened.lastSeen.getTime()).toBeGreaterThan(
      reopened.resolvedAt?.getTime() ?? 0,
    );
    expect(reopened.occurrenceCount).toBe(3);

    const occurrences = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getIssueOccurrences(issueId);
      }),
    );
    expect(occurrences.length).toBe(3);
  });

  test('stores same spanId on different traces as separate occurrences', async () => {
    dbPath = tempDbPath();

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        const shared = {
          fingerprint: 'fp-span-reuse',
          title: 'ValidationError: field email is required',
          service: 'api',
          exceptionType: 'ValidationError',
          spanId: 'shared-span-id',
          serviceName: 'api',
          timestamp: Date.now(),
          exceptionMessage: 'field email is required',
          attributes: {},
        };
        yield* store.upsertOccurrence({
          ...shared,
          traceId: 'trace-one',
        });
        yield* store.upsertOccurrence({
          ...shared,
          traceId: 'trace-two',
        });
      }),
    );

    const issues = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.listIssues({});
      }),
    );

    expect(issues.length).toBe(1);
    expect(issues[0].occurrenceCount).toBe(2);
  });

  test('dedupes occurrences by issueId, traceId, and spanId', async () => {
    dbPath = tempDbPath();

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        const input = {
          fingerprint: 'fp-dedupe',
          title: 'ValidationError: field email is required',
          service: 'api',
          exceptionType: 'ValidationError',
          traceId: 'trace-dedupe',
          spanId: 'span-dedupe',
          serviceName: 'api',
          timestamp: Date.now(),
          exceptionMessage: 'field email is required',
          attributes: {},
        };
        yield* store.upsertOccurrence(input);
        yield* store.upsertOccurrence(input);
      }),
    );

    const issues = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.listIssues({});
      }),
    );

    expect(issues.length).toBe(1);
    expect(issues[0].occurrenceCount).toBe(1);
  });

  test('keeps lastSeen monotonic when a late span arrives via overlap', async () => {
    dbPath = tempDbPath();
    const later = Date.now() + 5000;
    const earlier = Date.now();

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        yield* store.upsertOccurrence({
          fingerprint: 'fp-last-seen',
          title: 'TimeoutError: request timed out',
          service: 'api',
          exceptionType: 'TimeoutError',
          traceId: 'trace-later',
          spanId: 'span-later',
          serviceName: 'api',
          timestamp: later,
          exceptionMessage: 'request timed out after 30000ms',
          attributes: {},
        });
      }),
    );

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        yield* store.upsertOccurrence({
          fingerprint: 'fp-last-seen',
          title: 'TimeoutError: request timed out',
          service: 'api',
          exceptionType: 'TimeoutError',
          traceId: 'trace-earlier',
          spanId: 'span-earlier',
          serviceName: 'api',
          timestamp: earlier,
          exceptionMessage: 'request timed out after 30000ms',
          attributes: {},
        });
      }),
    );

    const issue = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        const issues = yield* store.listIssues({});
        return issues[0];
      }),
    );

    expect(issue.occurrenceCount).toBe(2);
    expect(issue.lastSeen.getTime()).toBe(later);
  });

  test('listIssuesWithSummary filters by status and service with counts', async () => {
    dbPath = tempDbPath();

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        const base = {
          exceptionType: 'ValidationError',
          serviceName: 'api',
          timestamp: Date.now(),
          exceptionMessage: 'field email is required',
          attributes: {},
        };
        yield* store.upsertOccurrence({
          ...base,
          fingerprint: 'fp-api',
          title: 'ValidationError: field email is required',
          service: 'api',
          traceId: 'trace-api',
          spanId: 'span-api',
        });
        yield* store.upsertOccurrence({
          ...base,
          fingerprint: 'fp-db',
          title: 'DatabaseConnectionError: connection refused',
          service: 'db',
          exceptionType: 'DatabaseConnectionError',
          exceptionMessage: 'connection refused',
          traceId: 'trace-db',
          spanId: 'span-db',
        });
        yield* store.resolveIssue(
          (
            yield* store.listIssues({ service: 'db' })
          )[0].id,
        );
      }),
    );

    const unresolved = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.listIssuesWithSummary({ status: 'unresolved' });
      }),
    );

    expect(unresolved.summary.totalCount).toBe(1);
    expect(unresolved.summary.serviceCount).toBe(1);
    expect(unresolved.issues[0].service).toBe('api');

    const resolved = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.listIssuesWithSummary({ status: 'resolved' });
      }),
    );

    expect(resolved.summary.totalCount).toBe(1);
    expect(resolved.issues[0].service).toBe('db');
  });

  test('paginates occurrences and buckets histogram in SQL', async () => {
    dbPath = tempDbPath();
    const baseTime = Date.UTC(2026, 5, 12, 10, 0, 0);

    const issueId = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        for (let index = 0; index < 55; index += 1) {
          yield* store.upsertOccurrence({
            fingerprint: 'fp-pagination',
            title: 'TimeoutError: request timed out',
            service: 'api',
            exceptionType: 'TimeoutError',
            traceId: `trace-${index}`,
            spanId: `span-${index}`,
            serviceName: 'api',
            timestamp: baseTime + index * 60_000,
            exceptionMessage: 'request timed out after 30000ms',
            attributes: {},
          });
        }
        const issues = yield* store.listIssues({});
        return issues[0].id;
      }),
    );

    const pageOne = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getIssueOccurrencesPaginated(issueId, 1);
      }),
    );
    const pageTwo = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getIssueOccurrencesPaginated(issueId, 2);
      }),
    );

    expect(pageOne.totalCount).toBe(55);
    expect(pageOne.occurrences.length).toBe(50);
    expect(pageTwo.occurrences.length).toBe(5);

    const detail = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getIssueDetail(issueId);
      }),
    );
    expect(detail.latestOccurrence?.traceId).toBe('trace-54');

    const since = new Date(baseTime);
    const histogram = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getOccurrenceHistogram(issueId, 'hour', since);
      }),
    );
    expect(histogram.length).toBeGreaterThan(0);
    const totalBucketed = histogram.reduce(
      (sum, bucket) => sum + bucket.count,
      0,
    );
    expect(totalBucketed).toBe(55);

    const batch = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getOccurrenceHistograms([issueId], 'day', since);
      }),
    );
    expect(batch.get(issueId)?.length).toBeGreaterThan(0);
  });

  test('tracks ingest cursor per service', async () => {
    dbPath = tempDbPath();
    const cursor = new Date('2026-06-12T10:00:00.000Z');

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        const before = yield* store.getIngestCursor('web');
        expect(before).toBeNull();
        yield* store.setIngestCursor('web', cursor);
        const after = yield* store.getIngestCursor('web');
        expect(after?.toISOString()).toBe(cursor.toISOString());
      }),
    );
  });
});
