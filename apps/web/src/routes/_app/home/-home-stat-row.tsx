import type { HomeErrorRateResult, HomeStats } from '@traces/contract';

export function HomeStatRow(props: {
  readonly stats: HomeStats;
  readonly errorRate: HomeErrorRateResult | null;
  readonly isLoading: boolean;
}) {
  if (props.isLoading) {
    return (
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex h-20 flex-col justify-center gap-1 rounded border border-border-subtle bg-bg-subtle px-3"
          >
            <div className="h-3 w-20 animate-shimmer rounded bg-bg-raised" />
            <div className="h-6 w-16 animate-shimmer rounded bg-bg-raised" />
          </div>
        ))}
      </div>
    );
  }

  const stats = props.stats;
  const errorRate = props.errorRate;

  return (
    <div className="grid grid-cols-4 gap-3">
      <StatCell
        label="error occurrences"
        value={stats.occurrenceCount}
        delta={stats.occurrenceDelta}
        format="count"
      />
      <StatCell
        label="active issues"
        value={stats.activeIssueCount}
        delta={stats.activeIssueDelta}
        format="count"
      />
      <StatCell
        label="services reporting"
        value={stats.serviceCount}
        delta={stats.serviceDelta}
        format="count"
      />
      <StatCell
        label="error rate"
        value={errorRate !== null ? errorRate.errorRate : null}
        delta={null}
        format="percent"
        sampleSize={errorRate !== null ? errorRate.sampledTraceCount : null}
      />
    </div>
  );
}

function StatCell(props: {
  readonly label: string;
  readonly value: number | null;
  readonly delta: number | null;
  readonly format: 'count' | 'percent';
  readonly sampleSize?: number | null;
}) {
  const value = props.value;
  const delta = props.delta;

  const formattedValue = (() => {
    if (value === null) return '—';
    if (props.format === 'percent') {
      return `${value.toFixed(1)}%`;
    }
    return value.toString();
  })();

  const deltaClass = (() => {
    if (delta === null) return 'text-text-tertiary';
    if (delta > 0) return 'text-status-error';
    if (delta < 0) return 'text-status-ok';
    return 'text-text-tertiary';
  })();

  const formattedDelta = (() => {
    if (delta === null) return '';
    if (delta === 0) return '+0';
    const sign = delta > 0 ? '+' : '';
    if (props.format === 'percent') {
      return `${sign}${delta.toFixed(1)}%`;
    }
    return `${sign}${delta}`;
  })();

  return (
    <div className="flex h-20 flex-col justify-center gap-1 rounded border border-border-subtle bg-bg-subtle px-3">
      <span className="text-label uppercase tracking-wide text-text-tertiary">
        {props.label}
      </span>
      <div className="flex items-baseline gap-2">
        <span className="font-data text-title text-text-primary tabular-nums">
          {formattedValue}
        </span>
        {delta !== null && (
          <span className={`font-data text-data ${deltaClass}`}>
            {formattedDelta}
          </span>
        )}
      </div>
      {props.sampleSize !== undefined && props.sampleSize !== null && (
        <span className="text-label text-text-tertiary">
          from last {props.sampleSize} traces
        </span>
      )}
    </div>
  );
}
