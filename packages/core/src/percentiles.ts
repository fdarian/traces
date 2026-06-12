export function percentile(
  sortedDurations: ReadonlyArray<number>,
  p: number,
): number | null {
  if (p < 0 || p > 100) {
    return null;
  }
  if (sortedDurations.length === 0) {
    return null;
  }
  if (sortedDurations.length === 1) {
    const value = sortedDurations[0];
    if (value === undefined) {
      return null;
    }
    return value;
  }

  const index = (p / 100) * (sortedDurations.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  const lowerValue = sortedDurations[lower];
  const upperValue = sortedDurations[upper];
  if (lowerValue === undefined || upperValue === undefined) {
    return null;
  }

  return lowerValue + (upperValue - lowerValue) * weight;
}

export function computePercentiles(durations: ReadonlyArray<number>): {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
} {
  if (durations.length === 0) {
    return { p50: null, p95: null, p99: null };
  }

  const sorted = durations.slice().sort((a, b) => a - b);

  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}
