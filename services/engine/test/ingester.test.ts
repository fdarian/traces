import { afterEach, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import {
  TraceBackend,
  type TraceBackendInterface,
  type TraceSummary,
} from '@traces/core';
import { ConfigProvider, Effect, Layer } from 'effect';
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

function summary(
  traceId: string,
  errorSpanCount: number | undefined,
): TraceSummary {
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
    SqliteIssueStoreLayer,
  ).pipe(Layer.provide(configLayer));
  return Effect.runPromise(
    runIngestOnce.pipe(Effect.provide(layer), Effect.provide(configLayer)),
  ).then(() => ({ searchedServices, fetchedTraces }));
}

test('fetches full traces only for summaries with error spans', async () => {
  const result = await runIngest({
    services: ['web'],
    summaries: [
      summary('ok', 0),
      summary('unknown', undefined),
      summary('bad', 2),
    ],
  });
  expect(result.fetchedTraces).toEqual(['bad']);
});
