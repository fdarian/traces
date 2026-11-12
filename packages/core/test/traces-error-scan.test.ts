import { describe, expect, test } from 'bun:test';
import { Effect, Option } from 'effect';
import {
  fingerprintFromErrorSpan,
  fingerprintFromException,
  groupTraceErrors,
  memoizeGetTrace,
  type Span,
  scanTraceErrors,
  type Trace,
  type TraceBackendInterface,
  TraceNotFound,
  type TraceSummary,
} from '#/index.js';
import { nanoToIso } from '#/normalize.js';

const BASE_NANO = 1_791_800_000_000_000_000n;

const summary = (index: number, errors: number): TraceSummary => ({
  traceId: `t${String(index).padStart(4, '0')}`,
  rootService: 'web',
  rootOperation: 'GET /',
  spanCount: 3,
  errorSpanCount: errors,
  services: [{ name: 'web', spanCount: 3 }],
  startTimeUnixNano: (BASE_NANO + BigInt(index) * 1_000_000n).toString(),
  durationMs: 10,
});

const errorSpan = (
  traceIndex: number,
  service: string,
  overrides: Partial<Span> = {},
): Span => {
  const start = BASE_NANO + BigInt(traceIndex) * 1_000_000n;
  return {
    traceId: `t${String(traceIndex).padStart(4, '0')}`,
    spanId: `s${traceIndex}-${service}`,
    name: 'GET /api/x',
    kind: 'server',
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + 5_000_000n).toString(),
    durationMs: 5,
    status: { code: 'error', message: 'query failed for user 41' },
    attributes: [],
    events: [],
    resource: { serviceName: service, attributes: [] },
    ...overrides,
  };
};

const exceptionEvent = (type: string, message: string, stacktrace = '') => ({
  name: 'exception',
  timestamp: 0,
  attributes: [
    { key: 'exception.type', value: type },
    { key: 'exception.message', value: message },
    { key: 'exception.stacktrace', value: stacktrace },
  ],
});

const trace = (index: number, spans: ReadonlyArray<Span>): Trace => ({
  traceId: `t${String(index).padStart(4, '0')}`,
  spans,
});

const SCOPE = { service: 'web', otelService: 'mockingbird-web' };

describe('groupTraceErrors', () => {
  test('groups error spans without an exception by service, name and normalized status message', () => {
    const groups = groupTraceErrors(
      [
        trace(1, [errorSpan(1, 'mockingbird-web')]),
        trace(2, [
          errorSpan(2, 'mockingbird-web', {
            status: { code: 'error', message: 'query failed for user 977' },
          }),
        ]),
      ],
      SCOPE,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      source: 'traces',
      service: 'web',
      count: 2,
      sample: 'query failed for user 41',
      deploymentIds: [],
      traceId: 't0001',
      traceIds: ['t0001', 't0002'],
    });
    expect(groups[0]?.fingerprint).toBe(
      fingerprintFromErrorSpan(errorSpan(1, 'mockingbird-web')),
    );
  });

  test('uses the span name as the sample when the status has no message', () => {
    const [group] = groupTraceErrors(
      [
        trace(1, [
          errorSpan(1, 'mockingbird-web', { status: { code: 'error' } }),
        ]),
      ],
      SCOPE,
    );
    expect(group?.sample).toBe('GET /api/x');
  });

  test('an exception event is one occurrence each and fingerprints like the ingester', () => {
    const groups = groupTraceErrors(
      [
        trace(1, [
          errorSpan(1, 'mockingbird-web', {
            events: [
              exceptionEvent('TypeError', 'x is undefined'),
              exceptionEvent('RangeError', 'out of range'),
            ],
          }),
        ]),
      ],
      SCOPE,
    );
    expect(groups.map((group) => group.sample).sort()).toEqual([
      'RangeError: out of range',
      'TypeError: x is undefined',
    ]);
    expect(groups.map((group) => group.fingerprint)).toContain(
      fingerprintFromException('mockingbird-web', {
        type: 'TypeError',
        message: 'x is undefined',
        stacktrace: '',
      }),
    );
  });

  test('counts only spans of the scanned service and only error status', () => {
    const groups = groupTraceErrors(
      [
        trace(1, [
          errorSpan(1, 'engine'),
          errorSpan(1, 'mockingbird-web', {
            spanId: 'ok',
            status: { code: 'ok' },
          }),
        ]),
      ],
      SCOPE,
    );
    expect(groups).toEqual([]);
  });

  test('keeps three distinct sample traces, newest scanned first, and orders by count', () => {
    const traces = [5, 4, 3, 2, 1].map((index) =>
      trace(index, [errorSpan(index, 'mockingbird-web')]),
    );
    const other = trace(9, [
      errorSpan(9, 'mockingbird-web', {
        status: { code: 'error', message: 'other' },
      }),
    ]);
    const groups = groupTraceErrors([...traces, other], SCOPE);
    expect(groups.map((group) => group.count)).toEqual([5, 1]);
    expect(groups[0]?.traceIds).toEqual(['t0005', 't0004', 't0003']);
    expect(groups[0]?.firstSeen < groups[0]?.lastSeen).toBe(true);
  });
});

/** Jaeger as scanTraceErrors sees it: search returns the newest traces at or before the bound. */
const fakeBackend = (
  summaries: ReadonlyArray<TraceSummary>,
  traces: ReadonlyArray<Trace>,
) => {
  const fetched: Array<string> = [];
  const searches: Array<{
    service: string;
    limit: number | undefined;
    errorsOnly: boolean | undefined;
  }> = [];
  const backend: TraceBackendInterface = {
    listServices: Effect.succeed([]),
    listOperations: () => Effect.succeed([]),
    searchFullTraces: () => Effect.succeed([]),
    searchTagged: () => Effect.succeed(Option.none()),
    searchTraces: (query) => {
      searches.push({
        service: query.service,
        limit: query.limit,
        errorsOnly: query.errorsOnly,
      });
      const bound = BigInt(Date.parse(query.startTimeMax)) * 1_000_000n;
      return Effect.succeed(
        summaries
          .filter((candidate) => BigInt(candidate.startTimeUnixNano) <= bound)
          .sort((left, right) =>
            right.startTimeUnixNano.localeCompare(left.startTimeUnixNano),
          )
          .slice(0, query.limit),
      );
    },
    getTrace: (traceId) => {
      fetched.push(traceId);
      const found = traces.find((candidate) => candidate.traceId === traceId);
      return found === undefined
        ? Effect.fail(new TraceNotFound({ traceId }))
        : Effect.succeed(found);
    },
  };
  return { backend, fetched, searches };
};

const window = {
  since: new Date(Number(BASE_NANO / 1_000_000n) - 1000),
  until: new Date(Number(BASE_NANO / 1_000_000n) + 100_000),
};

const scan = (
  fake: ReturnType<typeof fakeBackend>,
  options: { maxErrorTraces?: number; scanCap?: number } = {},
) =>
  Effect.runPromise(
    scanTraceErrors({
      backend: fake.backend,
      ...SCOPE,
      ...window,
      maxErrorTraces: options.maxErrorTraces ?? 200,
      scanCap: options.scanCap ?? 1000,
      pageSize: 4,
    }),
  );

describe('scanTraceErrors', () => {
  test('fetches only traces whose summary has error spans', async () => {
    const fake = fakeBackend(
      [summary(1, 0), summary(2, 1), summary(3, 0), summary(4, 2)],
      [
        trace(2, [errorSpan(2, 'mockingbird-web')]),
        trace(4, [errorSpan(4, 'mockingbird-web')]),
      ],
    );
    const result = await scan(fake);
    expect([...fake.fetched].sort()).toEqual(['t0002', 't0004']);
    expect(result).toMatchObject({
      errorTraces: 2,
      scanned: 4,
      partial: false,
    });
    expect(result.countedSince).toBeUndefined();
    expect(result.groups[0]).toMatchObject({ count: 2 });
    expect(result.groups[0]?.traceIds).toEqual(['t0004', 't0002']);
    expect(fake.searches.every((s) => s.service === 'mockingbird-web')).toBe(
      true,
    );
  });

  test('asks Jaeger for error traces first and falls back to the unfiltered window when it answers nothing', async () => {
    const fake = fakeBackend(
      [summary(1, 1)],
      [trace(1, [errorSpan(1, 'mockingbird-web')])],
    );
    const filteredSearch = fake.backend.searchTraces;
    const backend = {
      ...fake.backend,
      searchTraces: (query: Parameters<typeof filteredSearch>[0]) =>
        query.errorsOnly !== true ? filteredSearch(query) : Effect.succeed([]),
    };
    const result = await Effect.runPromise(
      scanTraceErrors({
        backend,
        ...SCOPE,
        ...window,
        maxErrorTraces: 200,
        scanCap: 1000,
        pageSize: 4,
      }),
    );
    expect(result.errorTraces).toBe(1);
    expect(fake.searches.map((search) => search.errorsOnly)).toEqual([false]);
  });

  test('sends the error filter on the first search', async () => {
    const fake = fakeBackend(
      [summary(1, 1)],
      [trace(1, [errorSpan(1, 'mockingbird-web')])],
    );
    await scan(fake);
    expect(fake.searches[0]?.errorsOnly).toBe(true);
  });

  test('stops at the error-trace cap and says older ones were left', async () => {
    const summaries = [1, 2, 3, 4, 5, 6].map((index) => summary(index, 1));
    const fake = fakeBackend(
      summaries,
      summaries.map((s, i) =>
        trace(i + 1, [errorSpan(i + 1, 'mockingbird-web')]),
      ),
    );
    const result = await scan(fake, { maxErrorTraces: 3 });
    expect(result.errorTraces).toBe(3);
    expect(result.partial).toBe(true);
    expect([...fake.fetched].sort()).toEqual(['t0004', 't0005', 't0006']);
    expect(result.groups[0]?.count).toBe(3);
    // The counts include the oldest of the three fetched traces and nothing before it.
    expect(result.countedSince).toBe(
      nanoToIso(summary(4, 1).startTimeUnixNano),
    );
  });

  test('is partial when the scan cap stops it short of the cap on error traces', async () => {
    const fake = fakeBackend(
      [1, 2, 3, 4, 5, 6, 7, 8].map((index) => summary(index, 0)),
      [],
    );
    const result = await scan(fake, { scanCap: 4 });
    expect(result).toMatchObject({ errorTraces: 0, scanned: 4, partial: true });
    expect(result.countedSince).toBe(
      nanoToIso(summary(5, 0).startTimeUnixNano),
    );
  });

  test('skips a trace that expired between search and fetch', async () => {
    const fake = fakeBackend(
      [summary(1, 1), summary(2, 1)],
      [trace(2, [errorSpan(2, 'mockingbird-web')])],
    );
    const result = await scan(fake);
    expect(result.errorTraces).toBe(1);
    expect(result.groups[0]?.count).toBe(1);
  });
});

describe('memoizeGetTrace', () => {
  test('reads a trace once however many scans ask for it', async () => {
    const fake = fakeBackend([], [trace(1, [errorSpan(1, 'engine')])]);
    const getTrace = memoizeGetTrace(fake.backend);
    await Effect.runPromise(
      Effect.all([getTrace('t0001'), getTrace('t0001'), getTrace('t0001')], {
        concurrency: 'unbounded',
      }),
    );
    expect(fake.fetched).toEqual(['t0001']);
  });
});
