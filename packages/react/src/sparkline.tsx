/** Maps time-bucketed histogram data into a fixed-length counts array aligned to a sliding window. */
export function fillHistogramCounts(props: {
  readonly buckets: ReadonlyArray<{
    readonly bucketStart: number;
    readonly count: number;
  }>;
  readonly slotCount: number;
  readonly slotMs: number;
  readonly windowEnd: number;
}): ReadonlyArray<number> {
  const counts = Array.from({ length: props.slotCount }, () => 0);
  const windowStart = props.windowEnd - props.slotCount * props.slotMs;

  for (const bucket of props.buckets) {
    const offset = bucket.bucketStart - windowStart;
    const index = Math.floor(offset / props.slotMs);
    if (index >= 0 && index < props.slotCount) {
      counts[index] = bucket.count;
    }
  }

  return counts;
}

/**
 * Inline SVG sparkline that plots a sequence of counts as a polyline with a
 * terminal dot. Sized as `sm` (72×16) or `lg` (160×32); color defaults to the
 * accent token.
 *
 * @example
 * ```tsx
 * <Sparkline counts={issue.sparklineCounts} color="var(--status-error)" size="sm" />
 * ```
 */
export function Sparkline(props: {
  readonly counts: ReadonlyArray<number>;
  readonly color?: string;
  readonly size?: 'sm' | 'lg';
}) {
  const size = props.size ?? 'sm';
  const width = size === 'lg' ? 160 : 72;
  const height = size === 'lg' ? 32 : 16;
  const color = props.color ?? 'var(--accent)';

  if (props.counts.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden
      />
    );
  }

  const max = Math.max(...props.counts, 1);
  const points: Array<string> = [];
  const step =
    props.counts.length <= 1 ? width : width / (props.counts.length - 1);

  for (let index = 0; index < props.counts.length; index += 1) {
    const count = props.counts[index] ?? 0;
    const x = props.counts.length <= 1 ? width / 2 : index * step;
    const y = height - (count / max) * (height - 2) - 1;
    points.push(`${x},${y}`);
  }

  const lastPoint = points[points.length - 1] ?? `0,${height}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className="shrink-0"
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points.join(' ')}
        style={{ opacity: 0.7 }}
      />
      <circle
        cx={lastPoint.split(',')[0]}
        cy={lastPoint.split(',')[1]}
        r="1.5"
        fill={color}
      />
    </svg>
  );
}
