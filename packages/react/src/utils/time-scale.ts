import type { Span } from '@traces/core';
import { normalizeTimestampToMs } from '@traces/core';

export interface TimeBounds {
  readonly startMs: number;
  readonly endMs: number;
}

export interface ZoomWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export interface TimeTick {
  readonly ms: number;
  readonly label: string;
  readonly xRatio: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  let nice: number;
  if (normalized <= 1) {
    nice = 1;
  } else if (normalized <= 2) {
    nice = 2;
  } else if (normalized <= 5) {
    nice = 5;
  } else {
    nice = 10;
  }
  return nice * magnitude;
}

export function computeTraceTimeBounds(
  spans: ReadonlyArray<Span>,
): TimeBounds {
  if (spans.length === 0) {
    return { startMs: 0, endMs: 1 };
  }

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;

  for (const span of spans) {
    const spanStart = normalizeTimestampToMs(span.startTimeUnixNano);
    const spanEnd = normalizeTimestampToMs(span.endTimeUnixNano);
    if (spanStart < startMs) {
      startMs = spanStart;
    }
    if (spanEnd > endMs) {
      endMs = spanEnd;
    }
  }

  if (endMs <= startMs) {
    endMs = startMs + 1;
  }

  return { startMs, endMs };
}

export function timeToX(
  timeMs: number,
  zoom: ZoomWindow,
  widthPx: number,
): number {
  const range = zoom.endMs - zoom.startMs;
  if (range <= 0) {
    return 0;
  }
  const ratio = (timeMs - zoom.startMs) / range;
  const x = ratio * widthPx;
  return clamp(x, 0, widthPx);
}

export function xToTime(
  xPx: number,
  zoom: ZoomWindow,
  widthPx: number,
): number {
  const range = zoom.endMs - zoom.startMs;
  if (widthPx <= 0) {
    return zoom.startMs;
  }
  const ratio = xPx / widthPx;
  return zoom.startMs + ratio * range;
}

export function clampZoomWindow(
  zoom: ZoomWindow,
  bounds: TimeBounds,
  minWindowMs: number,
): ZoomWindow {
  const boundsRange = bounds.endMs - bounds.startMs;
  let windowMs = zoom.endMs - zoom.startMs;

  if (windowMs < minWindowMs) {
    windowMs = Math.min(minWindowMs, boundsRange);
    const mid = (zoom.startMs + zoom.endMs) / 2;
    let startMs = mid - windowMs / 2;
    let endMs = mid + windowMs / 2;
    if (startMs < bounds.startMs) {
      startMs = bounds.startMs;
      endMs = startMs + windowMs;
    }
    if (endMs > bounds.endMs) {
      endMs = bounds.endMs;
      startMs = endMs - windowMs;
    }
    return { startMs, endMs };
  }

  if (windowMs >= boundsRange) {
    return { startMs: bounds.startMs, endMs: bounds.endMs };
  }

  let startMs = zoom.startMs;
  let endMs = zoom.endMs;

  if (startMs < bounds.startMs) {
    startMs = bounds.startMs;
    endMs = startMs + windowMs;
  }
  if (endMs > bounds.endMs) {
    endMs = bounds.endMs;
    if (zoom.startMs >= bounds.startMs) {
      startMs = zoom.startMs;
    } else {
      startMs = endMs - windowMs;
    }
    if (startMs < bounds.startMs) {
      startMs = bounds.startMs;
    }
  }

  return { startMs, endMs };
}

export function formatTickLabel(ms: number, zoom: ZoomWindow): string {
  const offset = ms - zoom.startMs;
  if (offset >= 1000) {
    return `${(offset / 1000).toFixed(1)}s`;
  }
  return `${Math.round(offset)}ms`;
}

export function generateTimeTicks(
  zoom: ZoomWindow,
  tickCount: number,
): ReadonlyArray<TimeTick> {
  const range = zoom.endMs - zoom.startMs;
  if (range <= 0 || tickCount <= 0) {
    return [];
  }

  const rawStep = range / tickCount;
  const step = niceStep(rawStep);
  const ticks: Array<TimeTick> = [];
  const firstTick = Math.ceil(zoom.startMs / step) * step;

  for (let ms = firstTick; ms <= zoom.endMs; ms += step) {
    const xRatio = (ms - zoom.startMs) / range;
    ticks.push({
      ms,
      label: formatTickLabel(ms, zoom),
      xRatio,
    });
  }

  return ticks;
}