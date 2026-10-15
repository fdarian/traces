import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { TraceBackendUnauthorized, TraceNotFound } from '#/errors.js';
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
