import { expect, test } from 'bun:test';
import type { TraceSummary } from '@traces/core';
import {
  computeInterval,
  formatStartTimeMax,
  formatStartTimeMin,
  initialStepMs,
  onLimitHit,
  type StepPolicy,
  stepAfterCleanResult,
  toCountedTrace,
} from '#/service-stats/stats-step';

const policy: StepPolicy = { minStepMs: 5000, maxStepMs: 900_000 };

test('step doubles on a clean result up to the maximum', () => {
  expect(stepAfterCleanResult(5000, policy)).toBe(10_000);
  expect(stepAfterCleanResult(600_000, policy)).toBe(900_000);
  expect(stepAfterCleanResult(900_000, policy)).toBe(900_000);
});

test('limit hit halves the step down to the floor, then becomes a gap', () => {
  const wide = { startMs: 0, endMs: 300_000 };
  expect(onLimitHit(300_000, wide, policy)).toEqual({
    kind: 'halve',
    stepMs: 150_000,
  });
  expect(onLimitHit(8000, { startMs: 0, endMs: 8000 }, policy)).toEqual({
    kind: 'halve',
    stepMs: 5000,
  });
  expect(onLimitHit(5000, { startMs: 0, endMs: 5000 }, policy)).toEqual({
    kind: 'gap',
  });
});

test('limit hit on an interval cut short by `end` halves the interval, not the step', () => {
  expect(onLimitHit(300_000, { startMs: 0, endMs: 40_000 }, policy)).toEqual({
    kind: 'halve',
    stepMs: 20_000,
  });
  expect(onLimitHit(300_000, { startMs: 0, endMs: 3000 }, policy)).toEqual({
    kind: 'gap',
  });
});

test('initial step is clamped into the policy range', () => {
  expect(initialStepMs(300_000, policy)).toBe(300_000);
  expect(initialStepMs(1000, policy)).toBe(5000);
  expect(initialStepMs(300_000, { minStepMs: 1000, maxStepMs: 60_000 })).toBe(
    60_000,
  );
});

test('computeInterval caps at end and refuses empty intervals', () => {
  expect(computeInterval(1000, 5000, 100_000)).toEqual({
    startMs: 1000,
    endMs: 6000,
  });
  expect(computeInterval(1000, 5000, 3000)).toEqual({
    startMs: 1000,
    endMs: 3000,
  });
  expect(computeInterval(3000, 5000, 3000)).toBeNull();
  expect(computeInterval(4000, 5000, 3000)).toBeNull();
});

test('startTimeMax is end minus one nanosecond in RFC3339Nano', () => {
  expect(formatStartTimeMax(Date.parse('2026-01-02T03:04:05.000Z'))).toBe(
    '2026-01-02T03:04:04.999999999Z',
  );
  expect(formatStartTimeMax(Date.parse('2026-01-02T03:04:05.250Z'))).toBe(
    '2026-01-02T03:04:05.249999999Z',
  );
  expect(formatStartTimeMin(Date.parse('2026-01-02T03:04:05.250Z'))).toBe(
    '2026-01-02T03:04:05.250Z',
  );
});

function summary(overrides: Partial<TraceSummary>): TraceSummary {
  return {
    traceId: 't1',
    rootService: 'web',
    rootOperation: 'GET /',
    spanCount: 4,
    services: [{ name: 'web', spanCount: 4 }],
    startTimeUnixNano: '1700000000123456789',
    durationMs: 12.5,
    ...overrides,
  };
}

test('toCountedTrace floors start to ms from BigInt ns and defaults missing errors to 0', () => {
  expect(toCountedTrace(summary({}))).toEqual({
    traceId: 't1',
    startMs: 1_700_000_000_123,
    durationMs: 12.5,
    errorSpanCount: 0,
    rootService: 'web',
    rootOperation: 'GET /',
    spanCount: 4,
  });
  expect(toCountedTrace(summary({ errorSpanCount: 2 })).errorSpanCount).toBe(2);
});
