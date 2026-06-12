import { describe, expect, test } from 'bun:test';
import { computePercentiles, percentile } from '#/percentiles.js';

describe('percentile', () => {
  test('returns null for empty array', () => {
    expect(percentile([], 50)).toBeNull();
  });

  test('returns the only value for single element', () => {
    expect(percentile([42], 50)).toBe(42);
  });

  test('interpolates for two elements', () => {
    expect(percentile([10, 20], 50)).toBe(15);
    expect(percentile([10, 20], 25)).toBe(12.5);
  });

  test('returns exact value at integer index', () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(percentile(sorted, 50)).toBe(3);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 100)).toBe(5);
  });

  test('interpolates for non-integer index', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // p50: index = 0.5 * 9 = 4.5 → between 5 and 6
    expect(percentile(sorted, 50)).toBe(5.5);
    // p95: index = 0.95 * 9 = 8.55 → between 9 and 10
    expect(percentile(sorted, 95)).toBeCloseTo(9.55, 10);
  });
});

describe('computePercentiles', () => {
  test('returns nulls for empty array', () => {
    const result = computePercentiles([]);
    expect(result.p50).toBeNull();
    expect(result.p95).toBeNull();
    expect(result.p99).toBeNull();
  });

  test('computes p50/p95/p99 for durations', () => {
    const durations = [100, 50, 200, 150, 300];
    const result = computePercentiles(durations);
    // sorted: [50, 100, 150, 200, 300]
    // p50: index = 0.5 * 4 = 2.0 → 150
    expect(result.p50).toBe(150);
    // p95: index = 0.95 * 4 = 3.8 → 200 + 0.8 * 100 = 280
    expect(result.p95).toBe(280);
    // p99: index = 0.99 * 4 = 3.96 → 200 + 0.96 * 100 = 296
    expect(result.p99).toBe(296);
  });

  test('handles single element', () => {
    const result = computePercentiles([42]);
    expect(result.p50).toBe(42);
    expect(result.p95).toBe(42);
    expect(result.p99).toBe(42);
  });

  test('handles two elements', () => {
    const result = computePercentiles([10, 20]);
    expect(result.p50).toBe(15);
    expect(result.p95).toBe(19.5);
    expect(result.p99).toBe(19.9);
  });

  test('handles many elements', () => {
    const durations: Array<number> = [];
    for (let i = 1; i <= 100; i++) {
      durations.push(i);
    }
    const result = computePercentiles(durations);
    // p50: index = 0.5 * 99 = 49.5 → 50 + 0.5 = 50.5
    expect(result.p50).toBe(50.5);
    // p95: index = 0.95 * 99 = 94.05 → 95 + 0.05 = 95.05
    expect(result.p95).toBe(95.05);
    // p99: index = 0.99 * 99 = 98.01 → 99 + 0.01 = 99.01
    expect(result.p99).toBe(99.01);
  });
});
