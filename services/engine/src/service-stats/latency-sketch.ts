const ALPHA = 0.02;
const GAMMA = (1 + ALPHA) / (1 - ALPHA);
const LOG_GAMMA = Math.log(GAMMA);
const MIN_MS = 0.001;

/** Sparse DDSketch: bin index to count. Counts are always positive integers. */
export type LatencySketch = ReadonlyMap<number, number>;

export function binFor(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`invalid duration: ${durationMs}`);
  }
  if (durationMs <= MIN_MS) {
    return 0;
  }
  return Math.max(0, Math.ceil(Math.log(durationMs / MIN_MS) / LOG_GAMMA));
}

export function emptySketch(): LatencySketch {
  return new Map();
}

export function sketchFromDurations(
  durationsMs: Iterable<number>,
): LatencySketch {
  const bins = new Map<number, number>();
  for (const durationMs of durationsMs) {
    const bin = binFor(durationMs);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  return bins;
}

export function addDuration(
  sketch: LatencySketch,
  durationMs: number,
): LatencySketch {
  const bins = new Map(sketch);
  const bin = binFor(durationMs);
  bins.set(bin, (bins.get(bin) ?? 0) + 1);
  return bins;
}

export function mergeSketches(
  a: LatencySketch,
  b: LatencySketch,
): LatencySketch {
  const bins = new Map(a);
  for (const [bin, count] of b) {
    bins.set(bin, (bins.get(bin) ?? 0) + count);
  }
  return bins;
}

export function sketchCount(sketch: LatencySketch): number {
  let total = 0;
  for (const count of sketch.values()) {
    total += count;
  }
  return total;
}

/** Null for an empty sketch. Within ±α of the exact rank-based sample quantile `sorted[ceil(q·n) − 1]`. */
export function quantile(sketch: LatencySketch, q: number): number | null {
  if (!(q >= 0 && q <= 1)) {
    throw new Error(`quantile out of range: ${q}`);
  }
  const total = sketchCount(sketch);
  if (total === 0) {
    return null;
  }
  const rank = Math.max(1, Math.ceil(q * total));
  let cumulative = 0;
  for (const [bin, count] of sortedEntries(sketch)) {
    cumulative += count;
    if (cumulative >= rank) {
      return representative(bin);
    }
  }
  throw new Error('rank exceeds sketch count');
}

// Bin 0 only holds durations <= MIN_MS (a microsecond), which are zero at the
// millisecond precision the backend reports, so it reports 0 instead of a midpoint.
function representative(bin: number): number {
  if (bin === 0) {
    return 0;
  }
  return ((2 * GAMMA ** bin) / (GAMMA + 1)) * MIN_MS;
}

function sortedEntries(sketch: LatencySketch): [number, number][] {
  return [...sketch.entries()].sort((x, y) => x[0] - y[0]);
}

export function encodeSketch(sketch: LatencySketch): string {
  const record: Record<string, number> = {};
  for (const [bin, count] of sortedEntries(sketch)) {
    record[String(bin)] = count;
  }
  return JSON.stringify(record);
}

export function decodeSketch(text: string): LatencySketch {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('malformed latency sketch: expected an object');
  }
  const bins = new Map<number, number>();
  for (const [key, count] of Object.entries(parsed)) {
    const bin = Number(key);
    if (!Number.isSafeInteger(bin) || bin < 0 || String(bin) !== key) {
      throw new Error(`malformed latency sketch: bad bin "${key}"`);
    }
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      throw new Error(`malformed latency sketch: bad count for bin ${key}`);
    }
    bins.set(bin, count);
  }
  return bins;
}
