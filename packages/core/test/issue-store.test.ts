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
    expect(reopened.resolvedAt).toBeNull();
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
