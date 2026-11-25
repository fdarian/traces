import { afterEach, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import {
  TraceBackend,
  type TraceBackendInterface,
  type TraceSummary,
} from '@traces/core';
import { ConfigProvider, Effect, Layer, Option } from 'effect';
import { SqliteDbLayer } from '#/db/sqlite';
import { runIngestOnce } from '#/issues/ingester';
import { SqliteIssueStoreLayer } from '#/issues/sqlite-store';

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

function summary(traceId: string, errorSpanCount: number): TraceSummary {
  return {
    traceId,
    rootService: 'web',
    rootOperation: 'GET /',
    spanCount: 1,
    errorSpanCount,
    services: [{ name: 'web', spanCount: 1 }],
    startTimeUnixNano: '1700000000000000000',
    durationMs: 1,
  };
}

function runIngest(options: {
  services: ReadonlyArray<string>;
  summaries: ReadonlyArray<TraceSummary>;
  env?: Record<string, string>;
}) {
  dbPath = `/tmp/traces-ingester-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
  const searchedServices: Array<string> = [];
  const fetchedTraces: Array<string> = [];
  const backend: TraceBackendInterface = {
    listServices: Effect.succeed(options.services),
    listOperations: () => Effect.succeed([]),
    searchFullTraces: () => Effect.succeed([]),
    searchTagged: () => Effect.succeed(Option.none()),
    searchTraces: (query) => {
      searchedServices.push(query.service);
      return Effect.succeed(options.summaries);
    },
    getTrace: (traceId) => {
      fetchedTraces.push(traceId);
      return Effect.succeed({ traceId, spans: [] });
    },
  };
  const configLayer = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ TRACES_DB: dbPath, ...options.env }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(TraceBackend, backend),
    Layer.provide(SqliteIssueStoreLayer, SqliteDbLayer),
  ).pipe(Layer.provide(configLayer));
  return Effect.runPromise(
    runIngestOnce.pipe(Effect.provide(layer), Effect.provide(configLayer)),
  ).then(() => ({ searchedServices, fetchedTraces }));
}

test('fetches full traces only for summaries with error spans', async () => {
  const result = await runIngest({
    services: ['web'],
    summaries: [summary('ok', 0), summary('bad', 2)],
  });
  expect(result.fetchedTraces).toEqual(['bad']);
});

test('skips the jaeger service by default', async () => {
  const result = await runIngest({
    services: ['jaeger', 'web'],
    summaries: [],
  });
  expect(result.searchedServices).toEqual(['web']);
});

test('INGEST_EXCLUDE_SERVICES replaces the default list', async () => {
  const result = await runIngest({
    services: ['jaeger', 'web', 'db'],
    summaries: [],
    env: { INGEST_EXCLUDE_SERVICES: ' web , db ' },
  });
  expect(result.searchedServices).toEqual(['jaeger']);
});

test('INGEST_EXCLUDE_SERVICES=none excludes nothing', async () => {
  const result = await runIngest({
    services: ['jaeger', 'web'],
    summaries: [],
    env: { INGEST_EXCLUDE_SERVICES: 'none' },
  });
  expect(result.searchedServices).toEqual(['jaeger', 'web']);
});
