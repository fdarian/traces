import type { TrendBucket } from '@traces/contract';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export function HomeTrendChart(props: {
  readonly buckets: ReadonlyArray<TrendBucket>;
  readonly isLoading: boolean;
}) {
  if (props.isLoading) {
    return (
      <div className="h-48 rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-full items-center justify-center">
          <div className="h-32 w-full animate-shimmer rounded bg-bg-raised" />
        </div>
      </div>
    );
  }

  if (props.buckets.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded border border-border-subtle bg-bg-subtle">
        <span className="text-body text-text-secondary">
          no error occurrences in this range
        </span>
      </div>
    );
  }

  const data = props.buckets.map((bucket) => ({
    time: bucket.bucketStart,
    count: bucket.count,
    label: formatBucketLabel(bucket.bucketStart),
  }));

  return (
    <div className="h-48 rounded border border-border-subtle bg-bg-subtle px-3 py-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 4, left: 0 }}
        >
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--status-error)"
                stopOpacity={0.08}
              />
              <stop
                offset="100%"
                stopColor="var(--status-error)"
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{
              fontSize: 11,
              fontFamily: 'Geist Mono Variable',
              fill: 'var(--text-tertiary)',
            }}
            interval="preserveStartEnd"
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{
              fontSize: 11,
              fontFamily: 'Geist Mono Variable',
              fill: 'var(--text-tertiary)',
            }}
            width={32}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (active && payload !== null && payload.length > 0) {
                const point = payload[0];
                if (point !== undefined && point.value !== undefined) {
                  return (
                    <div className="rounded border border-border-default bg-bg-raised px-2 py-1 text-data font-data text-text-primary">
                      {point.value} occurrences
                    </div>
                  );
                }
              }
              return null;
            }}
          />
          <Area
            type="monotone"
            dataKey="count"
            stroke="var(--status-error)"
            strokeWidth={1.5}
            fill="url(#trendFill)"
            dot={false}
            activeDot={{ r: 3, fill: 'var(--status-error)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatBucketLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  if (hours === 0 && minutes === 0) {
    return `${month}-${day}`;
  }

  const hoursStr = hours.toString().padStart(2, '0');
  const minutesStr = minutes.toString().padStart(2, '0');
  return `${hoursStr}:${minutesStr}`;
}
