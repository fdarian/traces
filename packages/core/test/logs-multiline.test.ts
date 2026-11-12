import { describe, expect, test } from 'bun:test';
import { coalesceMultiline, groupErrors, type LogRecord } from '#/index.js';

const BASE = Date.parse('2026-10-12T00:00:00.000Z');

const line = (
  message: string,
  offsetMs: number,
  overrides: Partial<LogRecord> = {},
): LogRecord => ({
  ts: new Date(BASE + offsetMs).toISOString(),
  service: 'api',
  provider: 'railway',
  environment: 'production',
  deploymentId: 'dep-1',
  source: 'runtime',
  level: 'error',
  message,
  attrs: {},
  ...overrides,
});

describe('coalesceMultiline', () => {
  test('folds a stack dump into one event under its headline', () => {
    const events = coalesceMultiline([
      line('TypeError: x is undefined', 0),
      line('    at a.ts:1:2', 1),
      line('    at b.ts:3:4', 2),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ts: '2026-10-12T00:00:00.000Z',
      message: 'TypeError: x is undefined\n    at a.ts:1:2\n    at b.ts:3:4',
    });
  });

  test('folds an object dump so its fields never become groups', () => {
    const groups = groupErrors(
      coalesceMultiline([
        line('Request failed {', 0),
        line('    status: 500,', 0),
        line('  DATA_CLONE_ERR: 25,', 1),
        line('},', 1),
        line('Request failed {', 5_000),
        line('    status: 502,', 5_000),
        line('},', 5_001),
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 2 });
    expect(groups[0]?.sample).toBe(
      'Request failed {\n    status: 500,\n  DATA_CLONE_ERR: 25,\n},',
    );
  });

  test('moves a Bun source snippet below the error line that follows it', () => {
    const groups = groupErrors(
      coalesceMultiline([
        line('370 | status: 404,', 0),
        line('371 | });', 1),
        line('error: Not found', 2),
        line('      at handler (a.ts:1:2)', 3),
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sample).toBe(
      'error: Not found\n370 | status: 404,\n371 | });\n      at handler (a.ts:1:2)',
    );
    expect(groups[0]?.fingerprint).toBe(
      groupErrors(coalesceMultiline([line('error: Not found', 0)]))[0]
        ?.fingerprint,
    );
  });

  test('skips object fields that sorted ahead of the headline', () => {
    const [event] = coalesceMultiline([
      line('  INDEX_SIZE_ERR: 1,', 0),
      line('Request failed {', 0),
      line('}', 1),
    ]);
    expect(event?.message).toBe('Request failed {\n  INDEX_SIZE_ERR: 1,\n}');
  });

  test.each([
    ['  indented'],
    ['}'],
    [']'],
    ['at frame (a.ts:1:2)'],
    ['12 | const x = 1;'],
  ])('%j is a continuation, not a headline', (continuation) => {
    const [event] = coalesceMultiline([line(continuation, 0), line('Boom', 1)]);
    expect(event?.message).toBe(`Boom\n${continuation}`);
  });

  test('keeps the first line when every line is a continuation', () => {
    const [event] = coalesceMultiline([
      line('    at a', 0),
      line('}', 1),
      line('12 | x', 2),
    ]);
    expect(event?.message).toBe('    at a\n}\n12 | x');
  });

  test('picks the headline before capping the message', () => {
    const [event] = coalesceMultiline([
      ...Array.from({ length: 25 }, (_, index) =>
        line(`  field${index}`, index),
      ),
      line('Real headline', 26),
    ]);
    const lines = event?.message.split('\n') ?? [];
    expect(lines[0]).toBe('Real headline');
    expect(lines).toHaveLength(20);
  });

  test('chains on the previous record, not the first, and splits past the gap', () => {
    const events = coalesceMultiline([
      line('a', 0),
      line('b', 40),
      line('c', 80),
      line('d', 131),
    ]);
    expect(events.map((event) => event.message)).toEqual(['a\nb\nc', 'd']);
  });

  test('keeps two errors 10ms apart in different deployments separate', () => {
    const events = coalesceMultiline([
      line('Boom A', 0, { deploymentId: 'dep-1' }),
      line('Boom B', 10, { deploymentId: 'dep-2' }),
    ]);
    expect(events.map((event) => event.message)).toEqual(['Boom A', 'Boom B']);
  });

  test('keeps different services and level classes apart, and treats fatal as error', () => {
    const events = coalesceMultiline([
      line('one', 0),
      line('two', 5, { service: 'web' }),
      line('three', 8, { level: 'warn' }),
      line('four', 9, { level: 'fatal' }),
    ]);
    expect(events.map((event) => event.message)).toEqual([
      'one\nfour',
      'two',
      'three',
    ]);
  });

  test('is not split by another deployment interleaving', () => {
    const events = coalesceMultiline([
      line('head', 0, { deploymentId: 'dep-1' }),
      line('other', 1, { deploymentId: 'dep-2' }),
      line('    at x', 2, { deploymentId: 'dep-1' }),
    ]);
    expect(events.map((event) => event.message)).toEqual([
      'head\n    at x',
      'other',
    ]);
  });

  test('caps the joined message at 20 lines and keeps the first trace id found', () => {
    const records = [
      line('headline', 0),
      ...Array.from({ length: 40 }, (_, index) =>
        line(`    at frame${index}`, 1 + index, {
          traceId: index === 3 ? 'trace-3' : undefined,
        }),
      ),
    ];
    const events = coalesceMultiline(records);
    expect(events).toHaveLength(1);
    expect(events[0]?.message.split('\n')).toHaveLength(20);
    expect(events[0]?.traceId).toBe('trace-3');
  });

  test('leaves a lone record untouched apart from its line count', () => {
    const only = line('alone\nwith two lines', 0);
    expect(coalesceMultiline([only])).toEqual([{ ...only, lines: 2 }]);
  });

  test('lines counts every merged log line, past the sample cap', () => {
    const dump = Array.from({ length: 30 }, (_, index) =>
      line(`    field${index}: 1,`, index),
    );
    const [event] = coalesceMultiline([line('Request failed {', 0), ...dump]);
    expect(event?.lines).toBe(31);
    expect(event?.message.split('\n')).toHaveLength(20);
  });

  test('a record that is already multi-line counts its own lines', () => {
    const [event] = coalesceMultiline([line('Boom\n  at a\n  at b', 0)]);
    expect(event?.lines).toBe(3);
  });

  test('group lines add up across events while count stays the events', () => {
    const groups = groupErrors(
      coalesceMultiline([
        line('Request failed {', 0),
        line('    status: 500,', 1),
        line('},', 2),
        line('Request failed {', 5_000),
        line('    status: 502,', 5_001),
        line('},', 5_002),
      ]),
    );
    expect(groups[0]).toMatchObject({ count: 2, lines: 6 });
  });
});
