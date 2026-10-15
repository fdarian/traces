import { describe, expect, test } from 'bun:test';
import { type Span, type Trace, toSpanRows } from '#/index.js';

const BASE_NANO = 1_791_800_000_000_000_000n;

const span = (
  spanId: string,
  parentSpanId: string | undefined,
  startMs: number,
  overrides: Partial<Span> = {},
): Span => {
  const start = BASE_NANO + BigInt(startMs) * 1_000_000n;
  return {
    traceId: 'ab'.repeat(16),
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    name: `op-${spanId}`,
    kind: 'server',
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + 10_000_000n).toString(),
    durationMs: 10,
    status: { code: 'unset' },
    attributes: [],
    events: [],
    resource: { serviceName: 'web', attributes: [] },
    ...overrides,
  };
};

const trace = (spans: ReadonlyArray<Span>): Trace => ({
  traceId: 'ab'.repeat(16),
  spans,
});

const order = (spans: ReadonlyArray<Span>) =>
  toSpanRows(trace(spans)).map((row) => `${row.spanId}@${row.depth}`);

describe('toSpanRows ordering', () => {
  test('is depth first with children by start time, whatever the input order', () => {
    expect(
      order([
        span('late-child', 'root', 30),
        span('grandchild', 'early-child', 15),
        span('root', undefined, 0),
        span('early-child', 'root', 10),
      ]),
    ).toEqual(['root@0', 'early-child@1', 'grandchild@2', 'late-child@1']);
  });

  test('breaks start-time ties by span id so the output is stable', () => {
    expect(
      order([
        span('b', 'root', 5),
        span('a', 'root', 5),
        span('root', undefined, 0),
      ]),
    ).toEqual(['root@0', 'a@1', 'b@1']);
  });

  test('compares starts at nanosecond precision', () => {
    const later = span('later', 'root', 5, {
      startTimeUnixNano: (BASE_NANO + 5_000_002n).toString(),
    });
    const earlier = span('earlier', 'root', 5, {
      startTimeUnixNano: (BASE_NANO + 5_000_001n).toString(),
    });
    expect(order([later, earlier, span('root', undefined, 0)])).toEqual([
      'root@0',
      'earlier@1',
      'later@1',
    ]);
  });

  test('an empty trace has no rows', () => {
    expect(toSpanRows(trace([]))).toEqual([]);
  });
});

describe('toSpanRows orphans', () => {
  test('a span whose parent is missing is a root at depth 0 and keeps its parentSpanId', () => {
    const rows = toSpanRows(
      trace([
        span('root', undefined, 0),
        span('orphan', 'gone', 5),
        span('orphan-child', 'orphan', 6),
      ]),
    );
    expect(rows.map((row) => `${row.spanId}@${row.depth}`)).toEqual([
      'root@0',
      'orphan@0',
      'orphan-child@1',
    ]);
    expect(rows[1]?.parentSpanId).toBe('gone');
    expect(rows[0]).not.toHaveProperty('parentSpanId');
  });

  test('an empty parentSpanId counts as no parent', () => {
    const rows = toSpanRows(trace([span('root', '', 0)]));
    expect(rows[0]?.depth).toBe(0);
    expect(rows[0]).not.toHaveProperty('parentSpanId');
  });

  test('a parent cycle still yields every span exactly once', () => {
    const spans = [
      span('a', 'b', 0),
      span('b', 'a', 1),
      span('c', undefined, 2),
    ];
    const ids = toSpanRows(trace(spans)).map((row) => row.spanId);
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('toSpanRows fields', () => {
  test('maps service, ISO start, status, attributes and events', () => {
    const [row] = toSpanRows(
      trace([
        span('root', undefined, 0, {
          status: { code: 'error', message: 'boom' },
          resource: { serviceName: 'engine', attributes: [] },
          attributes: [
            { key: 'http.method', value: 'GET' },
            { key: 'http.status_code', value: 500 },
          ],
          events: [
            {
              name: 'cache.miss',
              timestamp: Number(BASE_NANO / 1_000_000n) + 3,
              attributes: [{ key: 'key', value: 'k1' }],
            },
          ],
        }),
      ]),
    );
    expect(row).toEqual({
      traceId: 'ab'.repeat(16),
      spanId: 'root',
      depth: 0,
      service: 'engine',
      name: 'op-root',
      kind: 'server',
      startTs: '2026-10-12T10:13:20.000000000Z',
      durationMs: 10,
      status: 'error',
      statusMessage: 'boom',
      attrs: { 'http.method': 'GET', 'http.status_code': 500 },
      events: [
        {
          name: 'cache.miss',
          ts: '2026-10-12T10:13:20.003Z',
          attrs: { key: 'k1' },
        },
      ],
    });
  });

  test('leaves out an empty status message', () => {
    const [row] = toSpanRows(
      trace([
        span('root', undefined, 0, { status: { code: 'ok', message: '' } }),
      ]),
    );
    expect(row).not.toHaveProperty('statusMessage');
  });
});

describe('toSpanRows exception promotion', () => {
  const exceptionEvent = (
    type: string,
    message: string,
    stacktrace?: string,
  ) => ({
    name: 'exception',
    timestamp: 0,
    attributes: [
      { key: 'exception.type', value: type },
      { key: 'exception.message', value: message },
      ...(stacktrace === undefined
        ? []
        : [{ key: 'exception.stacktrace', value: stacktrace }]),
    ],
  });

  test('moves the first exception event out of events and keeps later ones', () => {
    const [row] = toSpanRows(
      trace([
        span('root', undefined, 0, {
          events: [
            { name: 'log', timestamp: 0, attributes: [] },
            exceptionEvent(
              'TypeError',
              'first',
              'TypeError: first\n  at a (a.ts:1:1)',
            ),
            exceptionEvent('RangeError', 'second'),
          ],
        }),
      ]),
    );
    expect(row?.exception).toEqual({
      type: 'TypeError',
      message: 'first',
      stacktrace: 'TypeError: first\n  at a (a.ts:1:1)',
    });
    expect(row?.events.map((event) => event.name)).toEqual([
      'log',
      'exception',
    ]);
    expect(row?.events[1]?.attrs['exception.type']).toBe('RangeError');
  });

  test('omits the stacktrace when the event has none', () => {
    const [row] = toSpanRows(
      trace([
        span('root', undefined, 0, { events: [exceptionEvent('E', 'm')] }),
      ]),
    );
    expect(row?.exception).toEqual({ type: 'E', message: 'm' });
  });

  test('a span with no exception event has no exception field', () => {
    const [row] = toSpanRows(trace([span('root', undefined, 0)]));
    expect(row).not.toHaveProperty('exception');
  });
});
