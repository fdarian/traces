import { describe, expect, test } from 'bun:test';
import type { LogRecord } from '@traces/core';
import {
  collectCoverage,
  coverageNote,
  oldestLogTs,
  partialFields,
} from '#/partial-coverage.ts';

const record = (ts: string): LogRecord => ({
  ts,
  service: 'engine',
  provider: 'railway',
  environment: 'production',
  source: 'runtime',
  level: 'error',
  message: 'boom',
  attrs: {},
});

const CAPS = { logs: 2000, errorTraces: 200, scanned: 1000 };
const SINCE = new Date('2026-10-15T00:00:00Z');
const UNTIL = new Date('2026-10-16T00:00:00Z');

describe('oldestLogTs', () => {
  test('finds the oldest record whatever order the page is in', () => {
    expect(
      oldestLogTs([
        record('2026-10-15T10:00:02.000Z'),
        record('2026-10-15T10:00:01.000Z'),
        record('2026-10-15T10:00:03.000Z'),
      ]),
    ).toBe('2026-10-15T10:00:01.000Z');
  });

  test('a capped page with no records is a bug, not an empty coverage', () => {
    expect(() => oldestLogTs([])).toThrow('no records');
  });
});

describe('collectCoverage', () => {
  const capped = {
    name: 'engine',
    since: SINCE,
    page: {
      records: [record('2026-10-15T10:00:01.000Z')],
      next: { kind: 'railway-time' },
    },
  };
  const whole = {
    name: 'web',
    since: SINCE,
    page: { records: [record('2026-10-15T10:00:01.000Z')] },
  };
  const trace = (partial: boolean) => ({
    name: 'engine',
    since: SINCE,
    scan: {
      partial,
      countedSince: partial ? '2026-10-15T08:30:00.123456789Z' : undefined,
      errorTraces: 200,
      scanned: 340,
    },
  });

  test('covers only the services that hit a cap, per source', () => {
    const coverages = collectCoverage([capped, whole], [trace(true)], CAPS);
    expect([...coverages.keys()].sort()).toEqual([
      'logs\0engine',
      'traces\0engine',
    ]);
  });

  test('stamps the groups of a capped service and leaves the others alone', () => {
    const coverages = collectCoverage([capped, whole], [trace(true)], CAPS);
    const group = (source: 'logs' | 'traces', service: string) =>
      ({ source, service }) as Parameters<typeof partialFields>[1];
    expect(partialFields(coverages, group('logs', 'engine'))).toEqual({
      partial: true,
      countedSince: '2026-10-15T10:00:01.000Z',
    });
    expect(partialFields(coverages, group('logs', 'web'))).toEqual({
      partial: false,
    });
    expect(partialFields(coverages, group('traces', 'engine'))).toEqual({
      partial: true,
      countedSince: '2026-10-15T08:30:00.123456789Z',
    });
  });

  test('a partial trace scan without countedSince is a bug', () => {
    const broken = { ...trace(true), scan: { ...trace(true).scan } };
    broken.scan.countedSince = undefined;
    expect(() => collectCoverage([], [broken], CAPS)).toThrow('countedSince');
  });
});

describe('coverageNote', () => {
  const coverages = collectCoverage(
    [
      {
        name: 'engine',
        since: SINCE,
        page: {
          records: [record('2026-10-15T10:00:01.000Z')],
          next: { kind: 'railway-time' },
        },
      },
    ],
    [
      {
        name: 'engine',
        since: SINCE,
        scan: {
          partial: true,
          countedSince: '2026-10-15T08:30:00.123456789Z',
          errorTraces: 200,
          scanned: 340,
        },
      },
    ],
    CAPS,
  );
  const covered = (key: string) => {
    const found = coverages.get(key);
    if (found === undefined) throw new Error(`no coverage for ${key}`);
    return found;
  };
  const log = covered('logs\0engine');
  const traces = covered('traces\0engine');

  test('a log note says which range the counts cover and which window was asked for', () => {
    expect(coverageNote(log, UNTIL, true)).toBe(
      'note: engine: hit the 2000-log cap; counts cover 2026-10-15T10:00:01Z -> 2026-10-16T00:00:00Z, not the whole window from 2026-10-15T00:00:00Z. Narrow --since for exact counts.',
    );
  });

  test('a single service needs no label', () => {
    expect(coverageNote(log, UNTIL, false)).toStartWith(
      'note: hit the 2000-log cap; counts cover',
    );
  });

  test('a trace note keeps the scan detail and parses the nanosecond start', () => {
    expect(coverageNote(traces, UNTIL, true)).toBe(
      'note: engine (traces): trace scan was capped (200 error traces or 1000 traces scanned per service) after reading 200 error traces out of 340 scanned; counts cover 2026-10-15T08:30:00.123Z -> 2026-10-16T00:00:00Z, not the whole window from 2026-10-15T00:00:00Z. Narrow --since for exact counts.',
    );
  });
});
