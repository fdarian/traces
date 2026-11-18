import type { ServiceHealth } from '@traces/contract';
import { Duration } from '@traces/react';
import { formatClock, SAMPLED_TITLE, traceCountLabel } from '#/lib/utils';

export function HomeServiceHealth(props: {
  readonly health: ReadonlyArray<ServiceHealth>;
  readonly isLoading: boolean;
  readonly onServiceClick: (service: string) => void;
}) {
  if (props.isLoading) {
    return (
      <div className="rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          service health
        </div>
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="flex h-8 items-center gap-3 border-b border-border-subtle px-3"
          >
            <div className="h-3 w-20 animate-shimmer rounded bg-bg-raised" />
            <div className="h-3 w-12 animate-shimmer rounded bg-bg-raised" />
          </div>
        ))}
      </div>
    );
  }

  if (props.health.length === 0) {
    return (
      <div className="rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          service health
        </div>
        <div className="flex h-32 items-center justify-center text-body text-text-secondary">
          no services found
        </div>
      </div>
    );
  }

  const collectingStarts = props.health.flatMap((svc) =>
    svc.collectingSince === null ? [] : [svc.collectingSince],
  );
  const collectingSince =
    collectingStarts.length > 0 ? Math.max(...collectingStarts) : null;

  return (
    <div className="rounded border border-border-subtle bg-bg-subtle">
      <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        service health
      </div>
      {collectingSince !== null && (
        <div className="flex h-6 items-center border-b border-border-subtle px-3 text-label text-text-tertiary">
          collecting since {formatClock(collectingSince)}
        </div>
      )}
      <div className="flex h-8 items-center gap-3 border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        <span className="min-w-0 flex-1 text-left">service</span>
        <span className="w-16 shrink-0 text-right">traces</span>
        <span className="w-16 shrink-0 text-right">errors</span>
        <span className="w-20 shrink-0 text-right">p50</span>
        <span className="w-20 shrink-0 text-right">p95</span>
        <span className="w-20 shrink-0 text-right">p99</span>
      </div>
      {props.health.map((svc) => (
        <ServiceRow
          key={svc.service}
          health={svc}
          onClick={() => props.onServiceClick(svc.service)}
        />
      ))}
    </div>
  );
}

function ServiceRow(props: {
  readonly health: ServiceHealth;
  readonly onClick: () => void;
}) {
  const health = props.health;

  const errorRateClass = (() => {
    if (health.errorRate >= 10) return 'text-status-error';
    if (health.errorRate >= 5) return 'text-status-warn';
    return 'text-status-ok';
  })();

  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex h-8 w-full items-center gap-3 border-b border-border-subtle px-3 text-left transition-colors duration-120 hover:bg-bg-raised"
    >
      <span className="min-w-0 flex-1 truncate text-body text-text-primary">
        {health.service}
      </span>

      <span
        className="w-16 shrink-0 text-right font-data text-data text-text-primary"
        title={health.exact ? undefined : SAMPLED_TITLE}
      >
        {traceCountLabel(health.traceCount, health.exact)}
      </span>

      <span
        className={`w-16 shrink-0 text-right font-data text-data ${errorRateClass}`}
      >
        {health.errorRate.toFixed(1)}%
      </span>

      <span className="w-20 shrink-0 text-right font-data text-data text-text-primary">
        {health.p50 !== null ? <Duration ms={health.p50} /> : '—'}
      </span>

      <span className="w-20 shrink-0 text-right font-data text-data text-text-primary">
        {health.p95 !== null ? <Duration ms={health.p95} /> : '—'}
      </span>

      <span className="w-20 shrink-0 text-right font-data text-data text-text-primary">
        {health.p99 !== null ? <Duration ms={health.p99} /> : '—'}
      </span>
    </button>
  );
}
