import { describe, expect, test } from 'bun:test';
import { groupErrors, type LogRecord } from '@traces/core';

const record = (
  message: string,
  ts: string,
  overrides: Partial<LogRecord> = {},
): LogRecord => ({
  ts,
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

describe('groupErrors', () => {
  test('groups messages that differ only in ids and numbers', () => {
    const groups = groupErrors([
      record('Timeout after 3000ms for user 41', '2026-10-12T00:00:01Z'),
      record('Timeout after 5000ms for user 977', '2026-10-12T00:00:09Z', {
        deploymentId: 'dep-2',
      }),
      record('Timeout after 100ms for user 5', '2026-10-12T00:00:05Z'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      count: 3,
      firstSeen: '2026-10-12T00:00:01Z',
      lastSeen: '2026-10-12T00:00:09Z',
      sample: 'Timeout after 3000ms for user 41',
    });
    expect(groups[0]?.deploymentIds).toEqual(['dep-1', 'dep-2']);
  });

  test('only the first line decides the group', () => {
    const groups = groupErrors([
      record(
        'TypeError: x is undefined\n    at a.ts:1',
        '2026-10-12T00:00:01Z',
      ),
      record(
        'TypeError: x is undefined\n    at b.ts:2',
        '2026-10-12T00:00:02Z',
      ),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
  });

  test('sorts by count (ties: most recent first) and keeps services apart', () => {
    const groups = groupErrors([
      record('rare failure', '2026-10-12T00:00:01Z'),
      record('common failure', '2026-10-12T00:00:02Z'),
      record('common failure', '2026-10-12T00:00:03Z'),
      record('common failure', '2026-10-12T00:00:04Z', { service: 'web' }),
    ]);
    expect(groups.map((g) => [g.service, g.sample, g.count])).toEqual([
      ['api', 'common failure', 2],
      ['web', 'common failure', 1],
      ['api', 'rare failure', 1],
    ]);
  });

  test('records without a deployment contribute no deployment ids', () => {
    const groups = groupErrors([
      record('boom', '2026-10-12T00:00:01Z', { deploymentId: undefined }),
    ]);
    expect(groups[0]?.deploymentIds).toEqual([]);
  });
});
