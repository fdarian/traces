import { describe, expect, test } from 'bun:test';
import {
  addDuration,
  binFor,
  decodeSketch,
  emptySketch,
  encodeSketch,
  mergeSketches,
  quantile,
  sketchCount,
  sketchFromDurations,
} from '#/service-stats/latency-sketch';

const ALPHA = 0.02;
const MIN_MS = 0.001;
const HOUR_MS = 3_600_000;

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function logNormalDurations(n: number, seed: number): number[] {
  const random = mulberry32(seed);
  const durations: number[] = [];
  for (let i = 0; i < n; i++) {
    const u1 = 1 - random();
    const u2 = random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    durations.push(Math.exp(Math.log(50) + 1.5 * normal));
  }
  return durations;
}

function exactQuantile(durations: number[], q: number): number {
  const sorted = [...durations].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] as number;
}

describe('quantile', () => {
  for (const n of [1, 2, 10, 100, 1000, 10_000]) {
    test(`p50/p95/p99 within relative error alpha for n=${n}`, () => {
      const durations = logNormalDurations(n, 1234 + n);
      const sketch = sketchFromDurations(durations);
      for (const q of [0.5, 0.95, 0.99]) {
        const exact = exactQuantile(durations, q);
        const estimate = quantile(sketch, q) as number;
        expect(Math.abs(estimate - exact) / exact).toBeLessThanOrEqual(
          ALPHA + 1e-9,
        );
      }
    });
  }

  test('returns null for an empty sketch', () => {
    expect(quantile(emptySketch(), 0.5)).toBeNull();
  });

  test('q=0 returns the smallest value and q=1 the largest', () => {
    const sketch = sketchFromDurations([5, 50, 500]);
    expect(Math.abs((quantile(sketch, 0) as number) - 5) / 5).toBeLessThan(
      ALPHA + 1e-9,
    );
    expect(Math.abs((quantile(sketch, 1) as number) - 500) / 500).toBeLessThan(
      ALPHA + 1e-9,
    );
  });

  test('rejects q outside [0, 1]', () => {
    const sketch = sketchFromDurations([1]);
    expect(() => quantile(sketch, -0.1)).toThrow();
    expect(() => quantile(sketch, 1.1)).toThrow();
    expect(() => quantile(sketch, Number.NaN)).toThrow();
  });
});

describe('merge', () => {
  test('merge(sketch(A), sketch(B)) equals sketch(A union B)', () => {
    const a = logNormalDurations(700, 1);
    const b = logNormalDurations(1300, 2);
    const merged = mergeSketches(
      sketchFromDurations(a),
      sketchFromDurations(b),
    );
    expect(merged).toEqual(sketchFromDurations([...a, ...b]));
    expect(sketchCount(merged)).toBe(2000);
  });

  test('is order independent and does not mutate its inputs', () => {
    const a = sketchFromDurations([1, 2, 3]);
    const b = sketchFromDurations([3, 4, 5]);
    const aBefore = encodeSketch(a);
    expect(mergeSketches(a, b)).toEqual(mergeSketches(b, a));
    expect(encodeSketch(a)).toBe(aBefore);
  });

  test('addDuration returns a new sketch', () => {
    const base = sketchFromDurations([10]);
    const next = addDuration(base, 10);
    expect(sketchCount(base)).toBe(1);
    expect(sketchCount(next)).toBe(2);
    expect(next).toEqual(sketchFromDurations([10, 10]));
  });
});

describe('encode/decode', () => {
  test('round-trips', () => {
    const sketch = sketchFromDurations(logNormalDurations(500, 7));
    expect(decodeSketch(encodeSketch(sketch))).toEqual(sketch);
  });

  test('encodes as a JSON object of bin to count', () => {
    const sketch = sketchFromDurations([0, 0, 1]);
    const record = JSON.parse(encodeSketch(sketch)) as Record<string, number>;
    expect(record['0']).toBe(2);
    expect(Object.values(record).reduce((a, b) => a + b, 0)).toBe(3);
  });

  test('round-trips an empty sketch', () => {
    expect(encodeSketch(emptySketch())).toBe('{}');
    expect(decodeSketch('{}')).toEqual(emptySketch());
  });

  test('rejects garbage', () => {
    for (const text of [
      '',
      'not json',
      'null',
      '[]',
      '3',
      '"x"',
      '{"a":1}',
      '{"-1":1}',
      '{"1.5":1}',
      '{"01":1}',
      '{"1":0}',
      '{"1":-2}',
      '{"1":1.5}',
      '{"1":"2"}',
      '{"1":null}',
    ]) {
      expect(() => decodeSketch(text)).toThrow();
    }
  });
});

describe('edge cases', () => {
  test('0 ms and MIN_MS land in bin 0 and report 0', () => {
    const sketch = sketchFromDurations([0, MIN_MS]);
    expect(binFor(0)).toBe(0);
    expect(binFor(MIN_MS)).toBe(0);
    expect(quantile(sketch, 0.5)).toBe(0);
    expect(quantile(sketch, 1)).toBe(0);
  });

  test('just above MIN_MS leaves bin 0', () => {
    expect(binFor(MIN_MS * 1.0001)).toBe(1);
  });

  test('1 hour stays within alpha', () => {
    const sketch = sketchFromDurations([HOUR_MS]);
    const estimate = quantile(sketch, 0.5) as number;
    expect(Math.abs(estimate - HOUR_MS) / HOUR_MS).toBeLessThanOrEqual(
      ALPHA + 1e-9,
    );
  });

  test('rejects negative and non-finite durations', () => {
    for (const bad of [-1, -0.0001, Number.NaN, Infinity, -Infinity]) {
      expect(() => binFor(bad)).toThrow();
      expect(() => sketchFromDurations([bad])).toThrow();
      expect(() => addDuration(emptySketch(), bad)).toThrow();
    }
  });
});
