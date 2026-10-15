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

  test('leaves a lone record untouched', () => {
    const only = line('alone\nwith two lines', 0);
    expect(coalesceMultiline([only])).toEqual([only]);
  });
});
