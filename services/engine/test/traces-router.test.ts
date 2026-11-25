import { expect, test } from 'bun:test';
import { call, ORPCError } from '@orpc/server';
import {
  JaegerUnreachable,
  TraceBackend,
  type TraceBackendInterface,
  TraceBackendUnauthorized,
  TraceNotFound,
} from '@traces/core';
import { Context, Effect, Option } from 'effect';
import { HttpServerResponse } from 'effect/http';
import { handler } from '#/rpc/handler';
import type { EngineContext } from '#/rpc/implementer';
import { router } from '#/rpc/router';

const stubBackend: TraceBackendInterface = {
  listServices: Effect.succeed(['checkout', 'payments']),
  listOperations: () => Effect.succeed([]),
  searchFullTraces: () => Effect.succeed([]),
  searchTagged: () => Effect.succeed(Option.none()),
  searchTraces: () => Effect.succeed([]),
  getTrace: (traceId) => {
    if (traceId === 'unreachable') {
      return Effect.fail(new JaegerUnreachable({ cause: new Error('down') }));
    }
    if (traceId === 'unauthorized') {
      return Effect.fail(
        new TraceBackendUnauthorized({ status: 401, url: 'http://jaeger' }),
      );
    }
    return Effect.fail(new TraceNotFound({ traceId }));
  },
};

// The issue store is never touched by traces.* procedures.
const context = {
  'effect/context': Context.make(TraceBackend, stubBackend),
} as unknown as EngineContext;

test('traces.listServices returns the backend services', async () => {
  const result = await call(router.traces.listServices, undefined, {
    context,
  });
  expect(result).toEqual(['checkout', 'payments']);
});

test('traces.get on a missing trace yields TRACE_NOT_FOUND', async () => {
  const error = await call(
    router.traces.get,
    { traceId: 'abc' },
    { context },
  ).catch((caught: unknown) => caught);
  if (!(error instanceof ORPCError)) throw error;
  expect(error.code).toBe('TRACE_NOT_FOUND');
  expect(error.data).toEqual({ traceId: 'abc' });
});

test('traces.get maps JaegerUnreachable to JAEGER_UNREACHABLE', async () => {
  const error = await call(
    router.traces.get,
    { traceId: 'unreachable' },
    { context },
  ).catch((caught: unknown) => caught);
  if (!(error instanceof ORPCError)) throw error;
  expect(error.code).toBe('JAEGER_UNREACHABLE');
});

test('traces.get maps TraceBackendUnauthorized to JAEGER_UNAUTHORIZED', async () => {
  const error = await call(
    router.traces.get,
    { traceId: 'unauthorized' },
    { context },
  ).catch((caught: unknown) => caught);
  if (!(error instanceof ORPCError)) throw error;
  expect(error.code).toBe('JAEGER_UNAUTHORIZED');
  expect(error.message).toBe('Jaeger rejected the configured credentials');
});

test('RPC responses carry the contract status for defined errors', async () => {
  const response = await handler.handle(
    new Request('http://engine/rpc/traces/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { traceId: 'abc' } }),
    }),
    { prefix: '/rpc', context },
  );
  if (!response.matched) throw new Error('procedure not matched');
  // Global `Response` has no `status` under this tsconfig (no DOM lib).
  expect(HttpServerResponse.fromWeb(response.response).status).toBe(404);
});
