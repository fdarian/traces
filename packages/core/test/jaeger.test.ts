import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { Effect, Exit } from 'effect';
import {
  computeTraceSummary,
  mapTrace,
  mapTraceSummary,
  parseJson,
  validate,
} from '#/jaeger.js';
import {
  type OtelResourceSpan,
  OtelTraceSummariesResultSchema,
  type OtelTraceSummary,
  OtelTracesResultSchema,
} from '#/jaeger-schema.js';
import traceMultiSpan from './fixtures/trace-multi-span.json';
import traceSummaries from './fixtures/trace-summaries.json';

describe('mapTrace', () => {
  test('maps multi-span trace from fixture', () => {
    const data = traceMultiSpan as {
      result: { resourceSpans: Array<unknown> };
    };
    const trace = mapTrace(
      data.result.resourceSpans as ReadonlyArray<OtelResourceSpan>,
    );

    expect(trace.traceId).toBe('abc123def45678901234567890abcdef');
    expect(trace.spans.length).toBe(3);

    const rootSpan = trace.spans.find((s) => s.parentSpanId === undefined);
    expect(rootSpan).not.toBeUndefined();
    assert(rootSpan);
    expect(rootSpan.name).toBe('GET /api/users');
    expect(rootSpan.kind).toBe('2');
    expect(rootSpan.traceId).toBe('abc123def45678901234567890abcdef');
    expect(rootSpan.startTimeUnixNano).toBe('1700000000000000000');
    expect(rootSpan.endTimeUnixNano).toBe('1700000000600000000');
    expect(rootSpan.durationMs).toBe(600);
    expect(rootSpan.status.code).toBe('ok');
    expect(rootSpan.resource.serviceName).toBe('web');

    const httpMethodAttr = rootSpan.attributes.find(
      (a) => a.key === 'http.method',
    );
    assert(httpMethodAttr);
    expect(httpMethodAttr.value).toBe('GET');

    const httpStatusAttr = rootSpan.attributes.find(
      (a) => a.key === 'http.status_code',
    );
    assert(httpStatusAttr);
    expect(httpStatusAttr.value).toBe(200);

    const httpSecureAttr = rootSpan.attributes.find(
      (a) => a.key === 'http.secure',
    );
    assert(httpSecureAttr);
    expect(httpSecureAttr.value).toBe(true);

    const httpLatencyAttr = rootSpan.attributes.find(
      (a) => a.key === 'http.latency',
    );
    assert(httpLatencyAttr);
    expect(httpLatencyAttr.value).toBe(45.5);

    const httpTagsAttr = rootSpan.attributes.find((a) => a.key === 'http.tags');
    assert(httpTagsAttr);
    expect(httpTagsAttr.value).toEqual(['api', 'users']);

    const httpHeadersAttr = rootSpan.attributes.find(
      (a) => a.key === 'http.headers',
    );
    assert(httpHeadersAttr);
    expect(httpHeadersAttr.value).toEqual({
      'content-type': 'application/json',
    });

    const event = rootSpan.events.find((e) => e.name === 'processing');
    expect(event).not.toBeUndefined();
    assert(event);
    expect(event.timestamp).toBe(1700000000100);

    const childSpan = trace.spans.find((s) => s.spanId === 'span002');
    expect(childSpan).not.toBeUndefined();
    assert(childSpan);
    expect(childSpan.parentSpanId).toBe('span001');
    expect(childSpan.status.code).toBe('error');
    expect(childSpan.status.message).toBe(
      'connection refused to postgres:5432',
    );
    expect(childSpan.resource.serviceName).toBe('web');

    const exceptionEvent = childSpan.events.find((e) => e.name === 'exception');
    expect(exceptionEvent).not.toBeUndefined();
    assert(exceptionEvent);
    const exceptionTypeAttr = exceptionEvent.attributes.find(
      (a) => a.key === 'exception.type',
    );
    assert(exceptionTypeAttr);
    expect(exceptionTypeAttr.value).toBe('DatabaseConnectionError');

    const grandChildSpan = trace.spans.find((s) => s.spanId === 'span003');
    expect(grandChildSpan).not.toBeUndefined();
    assert(grandChildSpan);
    expect(grandChildSpan.parentSpanId).toBe('span002');
    expect(grandChildSpan.resource.serviceName).toBe('db');
  });
});

describe('computeTraceSummary', () => {
  test('computes summary from multi-span trace', () => {
    const data = traceMultiSpan as {
      result: { resourceSpans: Array<unknown> };
    };
    const trace = mapTrace(
      data.result.resourceSpans as ReadonlyArray<OtelResourceSpan>,
    );
    const summary = computeTraceSummary(trace);

    expect(summary.traceId).toBe('abc123def45678901234567890abcdef');
    expect(summary.rootService).toBe('web');
    expect(summary.rootOperation).toBe('GET /api/users');
    expect(summary.spanCount).toBe(3);
    expect(summary.errorSpanCount).toBe(1);
    expect(summary.services.length).toBe(2);
    const webService = summary.services.find((s) => s.name === 'web');
    assert(webService);
    expect(webService.spanCount).toBe(2);
    const dbService = summary.services.find((s) => s.name === 'db');
    assert(dbService);
    expect(dbService.spanCount).toBe(1);
    expect(summary.durationMs).toBe(600);
    expect(summary.startTimeUnixNano).toBe('1700000000000000000');
  });
});

describe('mapTraceSummary', () => {
  test('maps trace summaries from fixture', () => {
    const data = traceSummaries as { summaries: Array<unknown> };
    const summaries = data.summaries.map((s) =>
      mapTraceSummary(s as OtelTraceSummary),
    );

    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      expect(summary.traceId).toBeDefined();
      expect(summary.rootService).toBeDefined();
      expect(summary.rootOperation).toBeDefined();
      expect(summary.spanCount).toBeGreaterThan(0);
      if (summary.errorSpanCount !== undefined) {
        expect(summary.errorSpanCount).toBeGreaterThanOrEqual(0);
      }
      expect(summary.services.length).toBeGreaterThan(0);
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
      expect(summary.startTimeUnixNano).toBeDefined();
    }
  });
});

describe('parseJson', () => {
  test('parses valid JSON', async () => {
    const program = parseJson('{"hello":"world"}');
    const result = await Effect.runPromise(program);
    expect(result).toEqual({ hello: 'world' });
  });

  test('fails on invalid JSON', async () => {
    const program = parseJson('not-json');
    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe('validate', () => {
  test('validates traces schema from fixture', async () => {
    const data = traceMultiSpan;
    const program = Effect.gen(function* () {
      const parsed = yield* parseJson(JSON.stringify(data));
      return yield* validate(OtelTracesResultSchema, parsed);
    });
    const result = await Effect.runPromise(program);
    expect(result.result?.resourceSpans?.length).toBe(2);
  });

  test('validates trace summaries schema from fixture', async () => {
    const data = traceSummaries;
    const program = Effect.gen(function* () {
      const parsed = yield* parseJson(JSON.stringify(data));
      return yield* validate(OtelTraceSummariesResultSchema, parsed);
    });
    const result = await Effect.runPromise(program);
    expect(result.summaries?.length).toBeGreaterThan(0);
  });
});
