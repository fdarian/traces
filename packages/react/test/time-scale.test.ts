import type { Span } from '@traces/core';
import { describe, expect, test } from 'bun:test';
import {
  clampZoomWindow,
  computeTraceTimeBounds,
  formatTickLabel,
  generateTimeTicks,
  timeToX,
  xToTime,
} from '../src/utils/time-scale.js';

function makeSpan(startMs: number, endMs: number): Span {
  return {
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'op',
    kind: 'internal',
    startTimeUnixNano: String(startMs * 1_000_000),
    endTimeUnixNano: String(endMs * 1_000_000),
    durationMs: endMs - startMs,
    status: { code: 'ok' },
    attributes: [],
    events: [],
    resource: { serviceName: 'api', attributes: [] },
  };
}

describe('computeTraceTimeBounds', () => {
  test('returns min start and max end across spans', () => {
    const bounds = computeTraceTimeBounds([
      makeSpan(1000, 2000),
      makeSpan(1500, 5000),
    ]);
    expect(bounds.startMs).toBe(1000);
    expect(bounds.endMs).toBe(5000);
  });

  test('returns default bounds for empty trace', () => {
    const bounds = computeTraceTimeBounds([]);
    expect(bounds.startMs).toBe(0);
    expect(bounds.endMs).toBe(1);
  });
});

describe('timeToX', () => {
  const zoom = { startMs: 0, endMs: 1000 };

  test('maps start to 0 and end to width', () => {
    expect(timeToX(0, zoom, 500)).toBe(0);
    expect(timeToX(1000, zoom, 500)).toBe(500);
  });

  test('maps midpoint correctly', () => {
    expect(timeToX(500, zoom, 400)).toBe(200);
  });

  test('clamps out-of-range values', () => {
    expect(timeToX(-100, zoom, 500)).toBe(0);
    expect(timeToX(2000, zoom, 500)).toBe(500);
  });
});

describe('xToTime', () => {
  const zoom = { startMs: 100, endMs: 1100 };

  test('inverts timeToX mapping', () => {
    expect(xToTime(0, zoom, 1000)).toBe(100);
    expect(xToTime(500, zoom, 1000)).toBe(600);
    expect(xToTime(1000, zoom, 1000)).toBe(1100);
  });
});

describe('clampZoomWindow', () => {
  const bounds = { startMs: 0, endMs: 10000 };

  test('expands window below minimum span', () => {
    const zoom = { startMs: 100, endMs: 150 };
    const clamped = clampZoomWindow(zoom, bounds, 500);
    expect(clamped.endMs - clamped.startMs).toBe(500);
  });

  test('returns full bounds when window covers entire trace', () => {
    const zoom = { startMs: 0, endMs: 10000 };
    const clamped = clampZoomWindow(zoom, bounds, 100);
    expect(clamped.startMs).toBe(0);
    expect(clamped.endMs).toBe(10000);
  });

  test('shifts window when it exceeds bounds', () => {
    const zoom = { startMs: 9500, endMs: 10500 };
    const clamped = clampZoomWindow(zoom, bounds, 500);
    expect(clamped.endMs).toBe(10000);
    expect(clamped.startMs).toBe(9500);
  });
});

describe('formatTickLabel', () => {
  test('formats sub-second offsets as ms', () => {
    const zoom = { startMs: 1000, endMs: 2000 };
    expect(formatTickLabel(1250, zoom)).toBe('250ms');
  });

  test('formats second offsets with decimal', () => {
    const zoom = { startMs: 0, endMs: 5000 };
    expect(formatTickLabel(1500, zoom)).toBe('1.5s');
  });
});

describe('generateTimeTicks', () => {
  test('generates evenly spaced ticks within zoom window', () => {
    const zoom = { startMs: 0, endMs: 1000 };
    const ticks = generateTimeTicks(zoom, 5);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick.ms).toBeGreaterThanOrEqual(0);
      expect(tick.ms).toBeLessThanOrEqual(1000);
      expect(tick.xRatio).toBeGreaterThanOrEqual(0);
      expect(tick.xRatio).toBeLessThanOrEqual(1);
      expect(tick.label.length).toBeGreaterThan(0);
    }
  });

  test('returns empty array for invalid input', () => {
    expect(generateTimeTicks({ startMs: 100, endMs: 100 }, 5)).toEqual([]);
    expect(generateTimeTicks({ startMs: 0, endMs: 1000 }, 0)).toEqual([]);
  });
});