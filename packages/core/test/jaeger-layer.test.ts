import { describe, expect, test } from 'bun:test';
import { ConfigProvider, Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { TraceBackend } from '#/backend.js';
import { JaegerBackendLayer } from '#/jaeger.js';
import operationsFixture from './fixtures/operations.json';
import servicesFixture from './fixtures/services.json';
import traceDetailFixture from './fixtures/trace-detail.json';
import traceSummariesFixture from './fixtures/trace-summaries.json';
import tracesFixture from './fixtures/traces.json';

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function createMockClient(
  handlers: Record<string, { body: unknown; status?: number }>,
): HttpClient.HttpClient {
  return HttpClient.make((request) => {
    const url = new URL(request.url);
    const key = url.pathname + url.search;
    const handler = handlers[key];
    if (handler === undefined) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          mockResponse({ error: 'not found' }, 404),
        ),
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        mockResponse(handler.body, handler.status ?? 200),
      ),
    );
  });
}

function runWithMockClient<A, E>(
  handlers: Record<string, { body: unknown; status?: number }>,
  effect: Effect.Effect<A, E, TraceBackend>,
): Promise<A> {
  const clientLayer = Layer.succeed(
    HttpClient.HttpClient,
    createMockClient(handlers),
  );
  const configLayer = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ JAEGER_URL: 'http://localhost:16686' }),
  );
  const program = effect.pipe(
    Effect.provide(JaegerBackendLayer),
    Effect.provide(clientLayer),
    Effect.provide(configLayer),
  );
  return Effect.runPromise(program);
}

describe('JaegerBackendLayer', () => {
  test('listServices returns services from mock', async () => {
    const handlers = {
      '/api/v3/services': { body: servicesFixture },
    };
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.listServices;
    });
    const result = await runWithMockClient(handlers, effect);
    expect(result.length).toBeGreaterThan(0);
    expect(result.includes('web')).toBe(true);
  });

  test('listOperations returns operations from mock', async () => {
    const handlers = {
      '/api/v3/operations?service=web': { body: operationsFixture },
    };
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.listOperations('web');
    });
    const result = await runWithMockClient(handlers, effect);
    expect(result.length).toBeGreaterThan(0);
    expect(result.includes('GET /')).toBe(true);
  });

  test('getTrace returns trace from mock', async () => {
    const handlers = {
      '/api/v3/traces/abc123': { body: traceDetailFixture },
    };
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.getTrace('abc123');
    });
    const result = await runWithMockClient(handlers, effect);
    expect(result.traceId).toBeDefined();
    expect(result.spans.length).toBeGreaterThan(0);
  });

  test('getTrace returns TraceNotFound for 404', async () => {
    const handlers = {
      '/api/v3/traces/notfound': { body: { error: 'not found' }, status: 404 },
    };
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.getTrace('notfound');
    });
    const program = runWithMockClient(handlers, effect);
    await expect(program).rejects.toThrow();
  });

  test('searchTraces uses trace-summaries when available', async () => {
    const handlers = {
      '/api/v3/trace-summaries?query.service_name=web&query.start_time_min=2020-01-01T00%3A00%3A00Z&query.start_time_max=2030-01-01T00%3A00%3A00Z':
        { body: traceSummariesFixture },
    };
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.searchTraces({
        service: 'web',
        startTimeMin: '2020-01-01T00:00:00Z',
        startTimeMax: '2030-01-01T00:00:00Z',
      });
    });
    const result = await runWithMockClient(handlers, effect);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].traceId).toBeDefined();
  });

  test('searchTraces falls back to full traces when summaries 404', async () => {
    const handlers = {
      '/api/v3/trace-summaries?query.service_name=web&query.start_time_min=2020-01-01T00%3A00%3A00Z&query.start_time_max=2030-01-01T00%3A00%3A00Z':
        { body: { error: 'not found' }, status: 404 },
      '/api/v3/traces?query.service_name=web&query.start_time_min=2020-01-01T00%3A00%3A00Z&query.start_time_max=2030-01-01T00%3A00%3A00Z':
        { body: tracesFixture },
    };
    const effect = Effect.gen(function* () {
      const backend = yield* TraceBackend;
      return yield* backend.searchTraces({
        service: 'web',
        startTimeMin: '2020-01-01T00:00:00Z',
        startTimeMax: '2030-01-01T00:00:00Z',
      });
    });
    const result = await runWithMockClient(handlers, effect);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].traceId).toBeDefined();
  });
});
