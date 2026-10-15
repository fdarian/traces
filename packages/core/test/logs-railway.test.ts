import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import {
  type Cursor,
  makeRailwaySource,
  mapRailwayHttpLog,
  mapRailwayLog,
  mapRailwayStatus,
  type RailwayTarget,
  shortHash,
} from '#/index.js';
import { fakeRailway, fixture, type RailwayCall } from './logs-helpers.ts';

const target: RailwayTarget = {
  provider: 'railway',
  service: 'api',
  project: 'proj-1',
  serviceName: 'api',
  environment: 'production',
};

const logRows = fixture('railway-environment-logs.json') as ReadonlyArray<{
  timestamp: string;
}>;

const respondWith =
  (rows: unknown) =>
  (call: RailwayCall): unknown => {
    if (call.document.includes('project(id'))
      return fixture('railway-project.json');
    if (call.document.includes('environmentLogs'))
      return { environmentLogs: rows };
    if (call.document.includes('deploymentLogs'))
      return { deploymentLogs: rows };
    if (call.document.includes('buildLogs')) return { buildLogs: rows };
    if (call.document.includes('httpLogs'))
      return { httpLogs: fixture('railway-http-logs.json') };
    if (call.document.includes('deployments('))
      return fixture('railway-deployments.json');
    throw new Error(`unexpected query: ${call.document}`);
  };

const run = <A>(effect: Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(effect);

const sourceWith = (rows: unknown, calls: Array<RailwayCall> = []) =>
  makeRailwaySource(target).pipe(
    Effect.provide(fakeRailway(respondWith(rows), calls)),
  );

describe('railway log mapping', () => {
  test('decodes JSON-encoded attributes and drops the level attribute', () => {
    const rows = fixture('railway-environment-logs.json') as Array<never>;
    const record = mapRailwayLog(rows[1] as never, {
      target,
      source: 'runtime',
    });
    expect(record.attrs).toEqual({ fiberId: '#9', spans: {}, count: 3 });
    expect(record.traceId).toBeUndefined();
    expect(record.level).toBe('info');
    expect(record.deploymentId).toBe('dep-1');
  });

  test('decodes nested Effect annotations and promotes well-formed trace ids', () => {
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    const row = {
      timestamp: '2026-10-12T00:25:58.664Z',
      message: 'hello',
      attributes: [
        {
          key: 'annotations',
          value: JSON.stringify({ traceId, spanId, userId: 7 }),
        },
        { key: 'raw', value: 'not json {' },
      ],
    };
    const record = mapRailwayLog(row as never, { target, source: 'runtime' });
    expect(record.traceId).toBe(traceId);
    expect(record.spanId).toBe(spanId);
    expect(record.attrs.annotations).toEqual({ traceId, spanId, userId: 7 });
    expect(record.attrs.raw).toBe('not json {');
  });

  test('accepts top-level snake_case ids and ignores malformed ones', () => {
    const encode = (attributes: Record<string, string>) => ({
      timestamp: '2026-10-12T00:25:58.664Z',
      message: 'hello',
      attributes: Object.entries(attributes).map(([key, value]) => ({
        key,
        value: JSON.stringify(value),
      })),
    });
    const good = mapRailwayLog(
      encode({ trace_id: 'C'.repeat(32), span_id: 'd'.repeat(16) }) as never,
      { target, source: 'runtime' },
    );
    expect(good.traceId).toBe('C'.repeat(32));
    expect(good.spanId).toBe('d'.repeat(16));
    const bad = mapRailwayLog(
      encode({ traceId: 'req-123', spanId: 'abc' }) as never,
      { target, source: 'runtime' },
    );
    expect(bad.traceId).toBeUndefined();
    expect(bad.spanId).toBeUndefined();
    expect(bad.attrs.traceId).toBe('req-123');
  });

  describe('appTs', () => {
    const rowWith = (timestamp: unknown) => ({
      timestamp: '2026-10-12T00:26:03.100Z',
      message: 'hello',
      attributes: [{ key: 'timestamp', value: JSON.stringify(timestamp) }],
    });
    const record = (timestamp: unknown) =>
      mapRailwayLog(rowWith(timestamp) as never, {
        target,
        source: 'runtime',
      });

    test('promotes attrs.timestamp as an ISO instant and leaves ts and attrs alone', () => {
      const mapped = record('2026-10-12T00:25:58.664Z');
      expect(mapped.appTs).toBe('2026-10-12T00:25:58.664Z');
      expect(mapped.ts).toBe('2026-10-12T00:26:03.100Z');
      expect(mapped.attrs.timestamp).toBe('2026-10-12T00:25:58.664Z');
    });

    test('normalizes an offset to UTC', () => {
      expect(record('2026-10-12T07:25:58.664+07:00').appTs).toBe(
        '2026-10-12T00:25:58.664Z',
      );
    });

    test.each([
      ['a bare number', 1_791_764_758_664],
      ['not a date', 'yesterday'],
      ['a lenient Date.parse hit', '1'],
      ['a date with no zone', '2026-10-12T00:25:58.664'],
      ['an impossible date', '2026-13-45T00:25:58Z'],
      ['an object', { at: '2026-10-12T00:25:58Z' }],
    ])('ignores %s', (_label, value) => {
      expect(record(value).appTs).toBeUndefined();
    });

    test('a record without the attribute has no appTs key', () => {
      const mapped = mapRailwayLog(
        {
          timestamp: '2026-10-12T00:26:03.100Z',
          message: 'x',
          attributes: [],
        } as never,
        { target, source: 'runtime' },
      );
      expect('appTs' in mapped).toBe(false);
    });
  });

  test('strips ANSI escapes from messages', () => {
    const rows = fixture('railway-environment-logs.json') as Array<never>;
    const record = mapRailwayLog(rows[2] as never, {
      target,
      source: 'runtime',
    });
    expect(record.message).toBe('boom: failed to bind port 8080');
    expect(record.level).toBe('error');
  });

  test('falls back to the level attribute and the query deployment id', () => {
    const rows = fixture('railway-environment-logs.json') as Array<never>;
    const record = mapRailwayLog(rows[3] as never, {
      target,
      source: 'build',
      deploymentId: 'dep-ctx',
    });
    expect(record.level).toBe('warn');
    expect(record.deploymentId).toBe('dep-ctx');
    expect(record.source).toBe('build');
  });

  test('maps http rows to request records with a status-derived level', () => {
    const rows = fixture('railway-http-logs.json') as Array<never>;
    const record = mapRailwayHttpLog(rows[1] as never, {
      target,
      deploymentId: 'dep-1',
    });
    expect(record.level).toBe('error');
    expect(record.message).toBe('POST /api/pay 502 1200ms');
    expect(record.request).toEqual({
      method: 'POST',
      path: '/api/pay',
      status: 502,
      durationMs: 1200,
      requestId: 'req-2',
    });
  });

  test('normalizes deployment statuses', () => {
    expect(mapRailwayStatus('SUCCESS')).toBe('ready');
    expect(mapRailwayStatus('SKIPPED')).toBe('canceled');
    expect(mapRailwayStatus('CRASHED')).toBe('crashed');
    expect(mapRailwayStatus('SOMETHING_NEW')).toBe('unknown');
  });
});

describe('railway source', () => {
  test('trims the limit+1 extra row and signals more history', async () => {
    const calls: Array<RailwayCall> = [];
    const page = await run(
      Effect.flatMap(sourceWith(logRows, calls), (source) =>
        source.logs({
          levels: [],
          limit: 3,
          since: new Date('2026-10-12T00:00:00Z'),
        }),
      ),
    );
    expect(page.records.map((r) => r.message)).toEqual([
      'Connected to postgres',
      'boom: failed to bind port 8080',
      'slow query',
    ]);
    expect(page.next?.kind).toBe('railway-time');
    const query = calls.find((c) => c.document.includes('environmentLogs'));
    expect(query?.variables.f).toBe(`@service:svc-api`);
    expect(query?.variables.l).toBe('3');
  });

  test('does not signal more history when the window is exhausted', async () => {
    const page = await run(
      Effect.flatMap(sourceWith(logRows.slice(1)), (source) =>
        source.logs({ levels: [], limit: 3 }),
      ),
    );
    expect(page.records).toHaveLength(3);
    expect(page.next).toBeUndefined();
  });

  test('builds level and grep filters', async () => {
    const calls: Array<RailwayCall> = [];
    await run(
      Effect.flatMap(sourceWith([], calls), (source) =>
        source.logs({ levels: ['error', 'warn'], grep: 'say "hi"', limit: 10 }),
      ),
    );
    const query = calls.find((c) => c.document.includes('environmentLogs'));
    expect(query?.variables.f).toBe(
      '@service:svc-api (@level:error OR @level:warn) "say \\"hi\\""',
    );
  });

  test('resumes after the cursor without repeating delivered rows', async () => {
    const cursor: Cursor = {
      kind: 'railway-time',
      before: '2026-10-12T00:25:58.664093687Z',
      seen: [shortHash('Connected to postgres')],
    };
    // the inclusive anchor re-sends the cursor row; the later rows must not leak in
    const page = await run(
      Effect.flatMap(sourceWith(logRows), (source) =>
        source.logs({ levels: [], limit: 5, cursor }),
      ),
    );
    expect(page.records.map((r) => r.message)).toEqual([
      'oldest row, the limit+1 extra',
    ]);
  });

  test('resolves services and environments by name, failing with the available names', async () => {
    const missing = makeRailwaySource({ ...target, serviceName: 'ghost' }).pipe(
      Effect.flatMap((source) => source.logs({ levels: [], limit: 1 })),
      Effect.provide(fakeRailway(respondWith([]))),
      Effect.result,
    );
    const result = await run(missing);
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(JSON.stringify(result.failure)).toContain(
        'api (svc-api), web (svc-web)',
      );
    }
  });

  test('resolves services and environments given by id', async () => {
    const calls: Array<RailwayCall> = [];
    await run(
      makeRailwaySource({
        ...target,
        serviceName: 'svc-web',
        environment: 'env-stg',
      }).pipe(
        Effect.flatMap((source) => source.logs({ levels: [], limit: 1 })),
        Effect.provide(fakeRailway(respondWith([]), calls)),
      ),
    );
    const query = calls.find((c) => c.document.includes('environmentLogs'));
    expect(query?.variables.e).toBe('env-stg');
    expect(query?.variables.f).toBe('@service:svc-web');
  });

  test('lists deployments with commit info from meta and skips missing fields', async () => {
    const page = await run(
      Effect.flatMap(sourceWith([]), (source) =>
        source.deployments({ limit: 3 }),
      ),
    );
    expect(page.deployments.map((d) => d.status)).toEqual([
      'canceled',
      'ready',
      'crashed',
    ]);
    expect(page.deployments[0]?.commit).toEqual({
      sha: '3e8c0810b11462237b12e6e4e8b6e2e21583b3d1',
      message: 'feat: skipped\n\nbody',
      branch: 'main',
    });
    expect(page.deployments[1]?.commit).toBeUndefined();
    expect(page.deployments[1]?.url).toBe('panel.example.com');
    expect(page.next).toEqual({ kind: 'railway-relay', after: 'R1BDOlM6YWJj' });
  });

  test('latest deployment skips SKIPPED ones for build logs', async () => {
    const calls: Array<RailwayCall> = [];
    await run(
      Effect.flatMap(sourceWith([], calls), (source) =>
        source.buildLogs({ levels: [], limit: 5, deploymentId: 'latest' }),
      ),
    );
    const build = calls.find((c) => c.document.includes('buildLogs'));
    expect(build?.variables.d).toBe('dep-ready');
  });

  test('turns "Not Authorized" into an auth error', async () => {
    const result = await run(
      makeRailwaySource(target).pipe(
        Effect.flatMap((source) => source.logs({ levels: [], limit: 1 })),
        Effect.provide(
          fakeRailway(() => null, [], {
            exitCode: 1,
            stdout: JSON.stringify({
              data: null,
              errors: [{ message: 'Not Authorized' }],
            }),
          }),
        ),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toMatchObject({ _tag: 'ProviderAuthError' });
    }
  });

  test('fails loudly when a row has the wrong shape', async () => {
    const result = await run(
      sourceWith([
        { timestamp: 'not a timestamp', message: 'x', attributes: [] },
      ]).pipe(
        Effect.flatMap((source) => source.logs({ levels: [], limit: 1 })),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toMatchObject({ _tag: 'ProviderResponseInvalid' });
    }
  });
});
