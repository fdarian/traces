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
          (yield* store.listIssues({ service: 'db' }))[0].id,
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

  test('getStats computes occurrences, active issues, and services with deltas', async () => {
    dbPath = tempDbPath();
    const baseTime = Date.UTC(2026, 5, 12, 10, 0, 0);
    const startTime = new Date(baseTime + 30 * 60 * 1000);
    const endTime = new Date(baseTime + 60 * 60 * 1000);
    const prevWindowStart = new Date(baseTime);

    const issueId = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        const shared = {
          fingerprint: 'fp-stats',
          title: 'TimeoutError: request timed out',
          service: 'api',
          exceptionType: 'TimeoutError',
          serviceName: 'api',
          exceptionMessage: 'request timed out',
          attributes: {},
        };
        // 3 occurrences in current window, 1 in previous window
        yield* store.upsertOccurrence({
          ...shared,
          traceId: 'trace-prev-1',
          spanId: 'span-prev-1',
          timestamp: prevWindowStart.getTime() + 1,
        });
        yield* store.upsertOccurrence({
          ...shared,
          traceId: 'trace-cur-1',
          spanId: 'span-cur-1',
          timestamp: startTime.getTime() + 1,
        });
        yield* store.upsertOccurrence({
          ...shared,
          traceId: 'trace-cur-2',
          spanId: 'span-cur-2',
          timestamp: startTime.getTime() + 2,
        });
        yield* store.upsertOccurrence({
          ...shared,
          traceId: 'trace-cur-3',
          spanId: 'span-cur-3',
          timestamp: startTime.getTime() + 3,
        });
        const issues = yield* store.listIssues({});
        return issues[0].id;
      }),
    );

    const stats = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getStats({}, startTime, endTime);
      }),
    );

    expect(stats.occurrenceCount).toBe(3);
    expect(stats.occurrenceDelta).toBe(2);
    expect(stats.activeIssueCount).toBe(1);
    expect(stats.activeIssueDelta).toBe(0);
    expect(stats.serviceCount).toBe(1);
    expect(stats.serviceDelta).toBe(0);

    // Resolve the issue and verify activeIssueCount drops to 0
    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        yield* store.resolveIssue(issueId);
      }),
    );

    const afterResolve = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getStats({}, startTime, endTime);
      }),
    );

    expect(afterResolve.activeIssueCount).toBe(0);
    // Resolved issue is no longer active in either window, so delta is 0
    expect(afterResolve.activeIssueDelta).toBe(0);
  });

  test('getStats filters by service', async () => {
    dbPath = tempDbPath();
    const baseTime = Date.UTC(2026, 5, 12, 10, 0, 0);
    const startTime = new Date(baseTime + 30 * 60 * 1000);
    const endTime = new Date(baseTime + 60 * 60 * 1000);

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        yield* store.upsertOccurrence({
          fingerprint: 'fp-api',
          title: 'TimeoutError: request timed out',
          service: 'api',
          exceptionType: 'TimeoutError',
          traceId: 'trace-api',
          spanId: 'span-api',
          serviceName: 'api',
          timestamp: startTime.getTime() + 1,
          exceptionMessage: 'request timed out',
          attributes: {},
        });
        yield* store.upsertOccurrence({
          fingerprint: 'fp-db',
          title: 'DatabaseConnectionError: connection refused',
          service: 'db',
          exceptionType: 'DatabaseConnectionError',
          traceId: 'trace-db',
          spanId: 'span-db',
          serviceName: 'db',
          timestamp: startTime.getTime() + 2,
          exceptionMessage: 'connection refused',
          attributes: {},
        });
      }),
    );

    const apiStats = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getStats({ service: 'api' }, startTime, endTime);
      }),
    );

    expect(apiStats.occurrenceCount).toBe(1);
    expect(apiStats.serviceCount).toBe(1);
  });

  test('getOccurrenceTrend buckets occurrences over time', async () => {
    dbPath = tempDbPath();
    const baseTime = Date.UTC(2026, 5, 12, 10, 0, 0);
    const startTime = new Date(baseTime);
    const endTime = new Date(baseTime + 60 * 60 * 1000);

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        const shared = {
          fingerprint: 'fp-trend',
          title: 'TimeoutError: request timed out',
          service: 'api',
          exceptionType: 'TimeoutError',
          serviceName: 'api',
          exceptionMessage: 'request timed out',
          attributes: {},
        };
        // 2 in first 5 min, 1 in second 5 min
        yield* store.upsertOccurrence({
          ...shared,
          traceId: 'trace-1',
          spanId: 'span-1',
          timestamp: baseTime + 1 * 60 * 1000,
        });
        yield* store.upsertOccurrence({
          ...shared,
          traceId: 'trace-2',
          spanId: 'span-2',
          timestamp: baseTime + 2 * 60 * 1000,
        });
        yield* store.upsertOccurrence({
          ...shared,
          traceId: 'trace-3',
          spanId: 'span-3',
          timestamp: baseTime + 8 * 60 * 1000,
        });
      }),
    );

    const trend = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getOccurrenceTrend({}, startTime, endTime);
      }),
    );

    expect(trend.length).toBe(2);
    expect(trend[0].count).toBe(2);
    expect(trend[1].count).toBe(1);
  });

  test('getTopUnresolvedIssues returns top issues by occurrence count', async () => {
    dbPath = tempDbPath();

    await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        const base = {
          serviceName: 'api',
          timestamp: Date.now(),
          exceptionMessage: 'boom',
          attributes: {},
        };
        yield* store.upsertOccurrence({
          ...base,
          fingerprint: 'fp-high',
          title: 'HighCountError: many',
          service: 'api',
          exceptionType: 'HighCountError',
          traceId: 'trace-high-1',
          spanId: 'span-high-1',
        });
        yield* store.upsertOccurrence({
          ...base,
          fingerprint: 'fp-high',
          title: 'HighCountError: many',
          service: 'api',
          exceptionType: 'HighCountError',
          traceId: 'trace-high-2',
          spanId: 'span-high-2',
        });
        yield* store.upsertOccurrence({
          ...base,
          fingerprint: 'fp-low',
          title: 'LowCountError: few',
          service: 'api',
          exceptionType: 'LowCountError',
          traceId: 'trace-low',
          spanId: 'span-low',
        });
      }),
    );

    const top = await runStore(
      dbPath,
      Effect.gen(function* () {
        const store = yield* IssueStore;
        return yield* store.getTopUnresolvedIssues({}, 8);
      }),
    );

    expect(top.length).toBe(2);
    expect(top[0].occurrenceCount).toBe(2);
    expect(top[0].title).toBe('HighCountError: many');
    expect(top[1].occurrenceCount).toBe(1);
    expect(top[1].title).toBe('LowCountError: few');
  });
});
