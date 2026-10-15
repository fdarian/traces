import { describe, expect, test } from 'bun:test';
import { Effect, Option, Redacted } from 'effect';
import {
  makeVercelSource,
  mapBuildEvent,
  mapHttpRow,
  mapRuntimeRow,
  mapVercelDeployment,
  mapVercelStatus,
  type VercelTarget,
} from '#/index.js';
import { fakeHttp, fixture, type HttpCall } from './logs-helpers.ts';

const target: VercelTarget = {
  provider: 'vercel',
  service: 'web',
  project: 'app',
  team: 'acme',
  environment: 'production',
};

const requestLogs = fixture('vercel-request-logs.json') as {
  rows: Array<never>;
  hasMoreRows: boolean;
};

const respond = (url: URL, logs: unknown = requestLogs) => {
  if (url.pathname.startsWith('/v9/projects/')) {
    return { body: fixture('vercel-project.json') };
  }
  if (url.pathname === '/api/logs/request-logs') return { body: logs };
  if (url.pathname === '/v6/deployments') {
    return { body: fixture('vercel-deployments.json') };
  }
  if (url.pathname.endsWith('/events')) {
    return { body: fixture('vercel-build-events.json') };
  }
  return { status: 404, body: {} };
};

const run = <A>(effect: Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(effect);

const sourceWith = (
  handler: (url: URL) => { status?: number; body: unknown } = respond,
  calls: Array<HttpCall> = [],
) =>
  makeVercelSource(target, Redacted.make('secret-token')).pipe(
    Effect.provide(fakeHttp(handler, calls)),
  );

describe('vercel row mapping', () => {
  test('runtime rows yield one record per log line, newest first', () => {
    const records = mapRuntimeRow(requestLogs.rows[0] as never, target);
    expect(records.map((r) => r.message)).toEqual([
      'Error: card declined\n    at charge (pay.ts:10)',
      'charging card',
    ]);
    expect(records[0]).toMatchObject({
      level: 'error',
      source: 'runtime',
      deploymentId: 'dpl_new',
      request: {
        method: 'POST',
        path: '/api/pay',
        status: 500,
        durationMs: 120,
      },
      traceId: '0123456789abcdef0123456789abcdef',
      attrs: { domain: 'app.example.com', branch: 'main' },
    });
  });

  test('rows without log lines produce no runtime records', () => {
    expect(mapRuntimeRow(requestLogs.rows[1] as never, target)).toEqual([]);
  });

  test('http rows derive the level from the status code', () => {
    const records = mapHttpRow(requestLogs.rows[0] as never, target);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'http',
      level: 'error',
      message: 'POST /api/pay 500 120ms',
    });
  });

  test('build events skip entries without a timestamp or text', () => {
    const events = fixture('vercel-build-events.json') as Array<never>;
    const mapped = events.map((event) =>
      mapBuildEvent(event, { target, deploymentId: 'dpl_new' }),
    );
    expect(mapped.map(Option.isSome)).toEqual([true, false, true, true, false]);
    const stderr = mapped[2];
    expect(stderr && Option.isSome(stderr) && stderr.value.level).toBe('error');
    expect(stderr && Option.isSome(stderr) && stderr.value.message).toBe(
      'warn: deprecated flag',
    );
    const fatal = mapped[3];
    expect(fatal && Option.isSome(fatal) && fatal.value.level).toBe('fatal');
  });

  test('maps deployments with github and gitlab commit metadata', () => {
    const data = fixture('vercel-deployments.json') as {
      deployments: Array<never>;
    };
    const [prod, preview, canceled] = data.deployments.map((deployment) =>
      mapVercelDeployment(deployment, target),
    );
    expect(prod).toMatchObject({
      id: 'dpl_prod',
      status: 'ready',
      rawStatus: 'READY',
      environment: 'production',
      createdAt: new Date(1791614805667).toISOString(),
      commit: {
        sha: '979403b39a53afc6b877f452bb5ba59fe98bc5a4',
        message: 'fix: thing (#26)',
        branch: 'main',
      },
    });
    expect(preview).toMatchObject({ status: 'failed', environment: 'preview' });
    expect(preview?.commit).toBeUndefined();
    expect(canceled).toMatchObject({
      status: 'canceled',
      commit: { sha: 'abc123', branch: 'dev' },
    });
    expect(canceled?.url).toBeUndefined();
  });

  test('normalizes statuses', () => {
    expect(mapVercelStatus('ERROR')).toBe('failed');
    expect(mapVercelStatus('DELETED')).toBe('removed');
    expect(mapVercelStatus('WEIRD')).toBe('unknown');
  });
});

describe('vercel source', () => {
  test('queries request-logs with the project id and its account as owner', async () => {
    const calls: Array<HttpCall> = [];
    const page = await run(
      Effect.flatMap(sourceWith(respond, calls), (source) =>
        source.logs({
          levels: ['error', 'fatal'],
          grep: 'card',
          limit: 10,
          since: new Date(1000),
          until: new Date(5000),
        }),
      ),
    );
    const url = new URL(
      calls.find((call) => call.url.includes('request-logs'))?.url ?? '',
    );
    expect(url.searchParams.get('projectId')).toBe('prj_123');
    expect(url.searchParams.get('ownerId')).toBe('team_abc');
    expect(url.searchParams.get('level')).toBe('error');
    expect(url.searchParams.get('search')).toBe('card');
    expect(url.searchParams.get('startDate')).toBe('1000');
    expect(url.searchParams.get('endDate')).toBe('5000');
    expect(url.searchParams.get('environment')).toBe('production');
    // warn-and-below lines of the same row are filtered client-side
    expect(page.records.map((r) => r.level)).toEqual(['error']);
    expect(page.next).toBeUndefined();
  });

  test('prints oldest to newest', async () => {
    const page = await run(
      Effect.flatMap(sourceWith(), (source) =>
        source.logs({ levels: [], limit: 10 }),
      ),
    );
    expect(page.records.map((r) => r.message)).toEqual([
      'charging card',
      'Error: card declined\n    at charge (pay.ts:10)',
    ]);
  });

  test('scopes team-bound calls with the team slug', async () => {
    const calls: Array<HttpCall> = [];
    await run(
      Effect.flatMap(sourceWith(respond, calls), (source) =>
        source.deployments({ limit: 1 }),
      ),
    );
    expect(calls.every((call) => call.url.includes('slug=acme'))).toBe(true);
  });

  test('stops mid-page with a skip cursor and resumes from it', async () => {
    const calls: Array<HttpCall> = [];
    const first = await run(
      Effect.flatMap(sourceWith(respond, calls), (source) =>
        source.logs({
          levels: [],
          limit: 1,
          since: new Date(1),
          until: new Date(9),
        }),
      ),
    );
    expect(first.records.map((r) => r.message)).toEqual([
      'Error: card declined\n    at charge (pay.ts:10)',
    ]);
    expect(first.next).toEqual({
      kind: 'vercel-page',
      since: 1,
      until: 9,
      page: 0,
      skip: 1,
    });
    const second = await run(
      Effect.flatMap(sourceWith(), (source) =>
        source.logs({ levels: [], limit: 1, cursor: first.next }),
      ),
    );
    expect(second.records.map((r) => r.message)).toEqual(['charging card']);
  });

  test('keeps paging until the limit is met', async () => {
    const calls: Array<HttpCall> = [];
    const pages = [
      { rows: [requestLogs.rows[1]], hasMoreRows: true },
      { rows: [requestLogs.rows[0]], hasMoreRows: false },
    ];
    const page = await run(
      Effect.flatMap(
        sourceWith(
          (url) =>
            url.pathname === '/api/logs/request-logs'
              ? {
                  body: pages[Number(url.searchParams.get('page'))] ?? {
                    rows: [],
                    hasMoreRows: false,
                  },
                }
              : respond(url),
          calls,
        ),
        (source) => source.logs({ levels: [], limit: 10 }),
      ),
    );
    expect(page.records).toHaveLength(2);
    expect(
      calls.filter((call) => call.url.includes('request-logs')),
    ).toHaveLength(2);
  });

  test('build logs resolve the latest deployment and come back oldest first', async () => {
    const calls: Array<HttpCall> = [];
    const page = await run(
      Effect.flatMap(sourceWith(respond, calls), (source) =>
        source.buildLogs({ levels: [], limit: 2, deploymentId: 'latest' }),
      ),
    );
    expect(page.records.map((r) => r.message)).toEqual([
      'warn: deprecated flag',
      'Build cache uploaded: 2.438s',
    ]);
    expect(page.next).toMatchObject({ kind: 'vercel-until' });
    const events = calls.find((call) => call.url.includes('/events'));
    expect(events?.url).toContain('/v3/deployments/dpl_prod/events');
    expect(events?.url).toContain('direction=backward');
  });

  test('401 and 403 become auth errors with a login hint', async () => {
    const result = await run(
      sourceWith(() => ({
        status: 403,
        body: { error: { message: 'no' } },
      })).pipe(
        Effect.flatMap((source) => source.deployments({ limit: 1 })),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toMatchObject({ _tag: 'ProviderAuthError' });
      expect(JSON.stringify(result.failure)).toContain('vercel login');
      expect(JSON.stringify(result.failure)).not.toContain('secret-token');
    }
  });

  test('fails loudly on an unexpected request-logs shape', async () => {
    const result = await run(
      sourceWith((url) =>
        url.pathname === '/api/logs/request-logs'
          ? { body: { rows: [{ nope: true }], hasMoreRows: false } }
          : respond(url),
      ).pipe(
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
