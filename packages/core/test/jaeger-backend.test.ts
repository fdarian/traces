import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import {
  JaegerBadResponse,
  TraceBackendUnauthorized,
  TraceNotFound,
} from '#/errors.js';
import { joinUrl, makeJaegerBackend } from '#/jaeger.js';
import servicesFixture from './fixtures/services.json';
import traceDetailFixture from './fixtures/trace-detail.json';

interface RecordedRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}

function recordingClient(
  status: number,
  body: unknown,
): { client: HttpClient.HttpClient; requests: Array<RecordedRequest> } {
  const requests: Array<RecordedRequest> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      url: new URL(request.url),
      headers: { ...request.headers },
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status }),
      ),
    );
  });
  return { client, requests };
}

function run<A, E>(
  client: HttpClient.HttpClient,
  options: Parameters<typeof makeJaegerBackend>[0],
  use: (
    backend: Effect.Success<ReturnType<typeof makeJaegerBackend>>,
  ) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(
    makeJaegerBackend(options).pipe(
      Effect.flatMap(use),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ),
  );
}

describe('joinUrl', () => {
  test.each([
    ['http://localhost:16686', 'http://localhost:16686/api/v3/services'],
    ['http://localhost:16686/', 'http://localhost:16686/api/v3/services'],
    [
      'https://host.example/~/jaeger',
      'https://host.example/~/jaeger/api/v3/services',
    ],
    [
      'https://host.example/~/jaeger/',
      'https://host.example/~/jaeger/api/v3/services',
    ],
  ])('%s keeps its path prefix', (base, expected) => {
    expect(joinUrl(new URL(base), '/api/v3/services').toString()).toBe(
      expected,
    );
  });
});

describe('makeJaegerBackend', () => {
  test('requests land under the base path with or without a trailing slash', async () => {
    for (const url of [
      'https://host.example/~/jaeger',
      'https://host.example/~/jaeger/',
    ]) {
      const { client, requests } = recordingClient(200, servicesFixture);
      const exit = await run(
        client,
        { url, headers: {} },
        (b) => b.listServices,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.map((r) => r.url.pathname)).toEqual([
        '/~/jaeger/api/v3/services',
      ]);
    }
  });

  test('query params are kept alongside the base path', async () => {
    const { client, requests } = recordingClient(200, { operations: [] });
    await run(
      client,
      { url: 'https://host.example/~/jaeger', headers: {} },
      (b) => b.listOperations('web'),
    );
    expect(requests[0]?.url.pathname).toBe('/~/jaeger/api/v3/operations');
    expect(requests[0]?.url.searchParams.get('service')).toBe('web');
  });

  test('getTrace url-encodes the trace id', async () => {
    const { client, requests } = recordingClient(200, traceDetailFixture);
    await run(client, { url: 'http://localhost:16686', headers: {} }, (b) =>
      b.getTrace('a/b?c'),
    );
    expect(requests[0]?.url.pathname).toBe('/api/v3/traces/a%2Fb%3Fc');
    expect(requests[0]?.url.search).toBe('');
  });

  test('sends configured headers on every request', async () => {
    const { client, requests } = recordingClient(200, servicesFixture);
    await run(
      client,
      { url: 'http://localhost:16686', headers: { 'X-API-Key': 'secret' } },
      (b) => b.listServices.pipe(Effect.andThen(b.listServices)),
    );
    expect(requests.length).toBe(2);
    for (const request of requests) {
      expect(request.headers['x-api-key']).toBe('secret');
    }
  });

  test.each([
    401, 403,
  ])('%d maps to TraceBackendUnauthorized', async (status) => {
    const { client } = recordingClient(status, { error: 'nope' });
    const exit = await run(
      client,
      { url: 'http://localhost:16686', headers: {} },
      (b) => b.listServices,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause.reasons[0];
      expect(error?._tag).toBe('Fail');
      if (error?._tag === 'Fail') {
        expect(error.error).toBeInstanceOf(TraceBackendUnauthorized);
        expect((error.error as TraceBackendUnauthorized).status).toBe(status);
      }
    }
  });

  test('401 on getTrace is unauthorized, not TraceNotFound', async () => {
    const { client } = recordingClient(401, {});
    const exit = await run(
      client,
      { url: 'http://localhost:16686', headers: {} },
      (b) => b.getTrace('abc'),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause.reasons[0];
      expect(error?._tag === 'Fail' && error.error).toBeInstanceOf(
        TraceBackendUnauthorized,
      );
      expect(error?._tag === 'Fail' && error.error).not.toBeInstanceOf(
        TraceNotFound,
      );
    }
  });
});

const legacyTrace = (
  traceID: string,
  startMicros: number,
  errorTag: { key: string; value: unknown } | undefined,
) => ({
  traceID,
  spans: [
    {
      traceID,
      spanID: 'root',
      operationName: 'GET /',
      references: [],
      startTime: startMicros,
      duration: 5_000,
      tags: [],
      processID: 'p1',
    },
    {
      traceID,
      spanID: 'child',
      operationName: 'db.query',
      references: [{ refType: 'CHILD_OF', traceID, spanID: 'root' }],
      startTime: startMicros + 1_000,
      duration: 9_000,
      tags: errorTag === undefined ? [] : [errorTag],
      processID: 'p2',
    },
  ],
  processes: {
    p1: { serviceName: 'web', tags: [] },
    p2: { serviceName: 'db', tags: [] },
  },
});

describe('searchTraces with attributes', () => {
  const query = {
    service: 'web',
    startTimeMin: '2026-10-12T00:00:00.000Z',
    startTimeMax: '2026-10-15T00:00:00.000Z',
    attributes: { error: 'true' },
    limit: 20,
  };

  test('asks the legacy API for the tags, because the v3 gateway ignores them', async () => {
    const { client, requests } = recordingClient(200, {
      data: [],
      total: 0,
      errors: null,
    });
    const exit = await run(
      client,
      { url: 'https://host.example/~/jaeger', headers: { 'X-API-Key': 'k' } },
      (b) => b.searchTraces(query),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const request = requests[0];
    expect(request?.url.pathname).toBe('/~/jaeger/api/traces');
    expect(request?.url.searchParams.get('service')).toBe('web');
    expect(request?.url.searchParams.get('tags')).toBe('{"error":"true"}');
    expect(request?.url.searchParams.get('limit')).toBe('20');
    expect(request?.url.searchParams.get('start')).toBe(
      String(Date.parse(query.startTimeMin) * 1000),
    );
    expect(request?.url.searchParams.get('end')).toBe(
      String(Date.parse(query.startTimeMax) * 1000),
    );
    expect(request?.headers['x-api-key']).toBe('k');
  });

  test('summarizes the legacy traces, counting error spans from either error tag', async () => {
    const { client } = recordingClient(200, {
      data: [
        legacyTrace('a'.repeat(32), 1_791_947_255_896_280, {
          key: 'otel.status_code',
          value: 'ERROR',
        }),
        legacyTrace('b'.repeat(32), 1_791_947_000_000_000, {
          key: 'error',
          value: true,
        }),
        legacyTrace('c'.repeat(32), 1_791_946_000_000_000, undefined),
      ],
      total: 3,
      errors: null,
    });
    const exit = await run(
      client,
      { url: 'http://localhost:16686', headers: {} },
      (b) => b.searchTraces(query),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.map((summary) => summary.errorSpanCount)).toEqual([
      1, 1, 0,
    ]);
    expect(exit.value[0]).toEqual({
      traceId: 'a'.repeat(32),
      rootService: 'web',
      rootOperation: 'GET /',
      spanCount: 2,
      errorSpanCount: 1,
      services: [
        { name: 'web', spanCount: 1 },
        { name: 'db', spanCount: 1 },
      ],
      startTimeUnixNano: '1791947255896280000',
      durationMs: 10,
    });
  });

  test('a legacy answer that is not 200 is a bad response', async () => {
    const { client } = recordingClient(500, { data: null, errors: [] });
    const exit = await run(
      client,
      { url: 'http://localhost:16686', headers: {} },
      (b) => b.searchTraces(query),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause.reasons[0];
      expect(error?._tag === 'Fail' && error.error._tag).toBe(
        'JaegerBadResponse',
      );
    }
  });

  test('searches without attributes stay on the v3 API', async () => {
    const { client, requests } = recordingClient(200, { summaries: [] });
    await run(client, { url: 'http://localhost:16686', headers: {} }, (b) =>
      b.searchTraces({ ...query, attributes: undefined }),
    );
    expect(requests[0]?.url.pathname).toBe('/api/v3/trace-summaries');
    expect(requests[0]?.url.searchParams.has('query.attributes')).toBe(false);
  });
});

function rawClient(
  status: number,
  body: string,
  headers: Readonly<Record<string, string>>,
): HttpClient.HttpClient {
  return HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, headers }),
      ),
    ),
  );
}

describe('JaegerBadResponse', () => {
  const failure = async (
    client: HttpClient.HttpClient,
    headers: Readonly<Record<string, string>> = {},
  ) => {
    const exit = await run(
      client,
      { url: 'http://localhost:16686', headers },
      (b) => b.listServices,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error('expected a failure');
    const reason = exit.cause.reasons[0];
    if (reason?._tag !== 'Fail') throw new Error('expected a typed failure');
    expect(reason.error).toBeInstanceOf(JaegerBadResponse);
    return reason.error as JaegerBadResponse;
  };

  test('carries the status, content-type and a whitespace-collapsed body prefix', async () => {
    const page = `<!doctype html>\n<html>\n  <head><title>${'x'.repeat(300)}</title></head></html>`;
    const error = await failure(
      rawClient(200, page, { 'content-type': 'text/html; charset=utf-8' }),
    );
    expect(error.status).toBe(200);
    expect(error.contentType).toBe('text/html; charset=utf-8');
    expect(error.body).toHaveLength(120);
    expect(
      error.body.startsWith('<!doctype html> <html> <head><title>xxx'),
    ).toBe(true);
  });

  test('a response without a content-type leaves it unset', async () => {
    const error = await failure(rawClient(302, '', {}));
    expect(error.status).toBe(302);
    expect(error.body).toBe('');
  });

  test('never carries the request headers', async () => {
    const error = await failure(
      rawClient(200, 'plain text', { 'content-type': 'text/plain' }),
      { 'X-API-Key': 'super-secret-token' },
    );
    expect(JSON.stringify(error)).not.toContain('super-secret-token');
    expect(String(error.cause)).not.toContain('super-secret-token');
  });

  test('a body that is valid JSON of the wrong shape still reports the response', async () => {
    const error = await failure(
      rawClient(200, '{"unexpected":true}', {
        'content-type': 'application/json',
      }),
    );
    expect(error.body).toBe('{"unexpected":true}');
  });
});
