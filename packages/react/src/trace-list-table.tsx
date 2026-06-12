import type { TraceSummary } from '@traces/core';
import { useMemo } from 'react';
import { Duration } from './duration.js';
import { EmptyState } from './empty-state.js';
import { ServiceBadge } from './service-badge.js';
import { SkeletonRow } from './skeleton-row.js';
import { StatusBadge } from './status-badge.js';

export function TraceListTable(props: {
  readonly traces: ReadonlyArray<TraceSummary>;
  readonly sort: 'start' | 'duration';
  readonly onSortChange: (sort: 'start' | 'duration') => void;
  readonly isLoading: boolean;
  readonly hasMore: boolean;
  readonly onLoadMore: () => void;
  readonly error: Error | null;
  readonly getTraceHref: (traceId: string) => string;
}) {
  if (props.error !== null) {
    return (
      <div className="px-4 py-12 text-body text-status-error">
        failed to load traces
      </div>
    );
  }

  if (props.isLoading && props.traces.length === 0) {
    return (
      <div>
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    );
  }

  if (props.traces.length === 0) {
    return <EmptyState message="no traces in this range" />;
  }

  const maxDuration = Math.max(...props.traces.map((t) => t.durationMs), 1);

  const sortedTraces = useMemo(() => {
    const arr = [...props.traces];
    if (props.sort === 'start') {
      arr.sort((a, b) => {
        const aStart = BigInt(a.startTimeUnixNano);
        const bStart = BigInt(b.startTimeUnixNano);
        if (bStart > aStart) return 1;
        if (bStart < aStart) return -1;
        return 0;
      });
    } else {
      arr.sort((a, b) => b.durationMs - a.durationMs);
    }
    return arr;
  }, [props.traces, props.sort]);

  return (
    <div>
      <div className="flex h-8 items-center gap-3 border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        <button
          type="button"
          onClick={() => props.onSortChange('start')}
          className="flex-1 text-left transition-colors duration-120 hover:text-text-primary"
        >
          start {props.sort === 'start' ? '▼' : ''}
        </button>
        <button
          type="button"
          onClick={() => props.onSortChange('duration')}
          className="w-32 shrink-0 text-left transition-colors duration-120 hover:text-text-primary"
        >
          duration {props.sort === 'duration' ? '▼' : ''}
        </button>
        <span className="w-16 shrink-0 text-right">spans</span>
        <span className="w-16 shrink-0 text-right">errors</span>
        <span className="w-32 shrink-0">services</span>
        <span className="w-24 shrink-0 text-right">start</span>
      </div>

      {sortedTraces.map((trace) => (
        <a
          key={trace.traceId}
          href={props.getTraceHref(trace.traceId)}
          className="flex h-8 items-center gap-3 border-b border-border-subtle px-3 transition-colors duration-120 hover:bg-bg-raised"
        >
          <div className="flex flex-1 items-center gap-2 overflow-hidden">
            <span className="truncate text-body text-text-primary">
              {trace.rootOperation}
            </span>
            <ServiceBadge name={trace.rootService} />
          </div>

          <div className="flex w-32 shrink-0 flex-col justify-center gap-0.5">
            <Duration ms={trace.durationMs} />
            <div
              className="h-0.5 bg-text-tertiary"
              style={{
                width: `${(trace.durationMs / maxDuration) * 100}%`,
              }}
            />
          </div>

          <span className="w-16 shrink-0 text-right font-data text-data text-text-primary">
            {trace.spanCount}
          </span>

          <div className="w-16 shrink-0 text-right">
            {trace.errorSpanCount > 0 && (
              <StatusBadge
                status="error"
                label={String(trace.errorSpanCount)}
              />
            )}
          </div>

          <div className="flex w-32 shrink-0 items-center">
            {trace.services.slice(0, 3).map((svc, idx) => (
              <div key={svc.name} className={idx > 0 ? '-ml-1' : ''}>
                <ServiceBadge name={svc.name} />
              </div>
            ))}
            {trace.services.length > 3 && (
              <span className="ml-1 font-data text-data text-text-tertiary">
                +{trace.services.length - 3}
              </span>
            )}
          </div>

          <span
            className="w-24 shrink-0 text-right font-data text-data text-text-tertiary"
            title={new Date(
              Number(BigInt(trace.startTimeUnixNano) / BigInt(1000000)),
            ).toISOString()}
          >
            {relativeTime(
              Number(BigInt(trace.startTimeUnixNano) / BigInt(1000000)),
            )}
          </span>
        </a>
      ))}

      {props.hasMore && (
        <div className="flex h-10 items-center justify-center border-b border-border-subtle">
          <button
            type="button"
            onClick={props.onLoadMore}
            disabled={props.isLoading}
            className="text-body text-text-secondary transition-colors duration-120 hover:text-text-primary disabled:text-text-tertiary"
          >
            {props.isLoading ? 'loading…' : 'load more'}
          </button>
        </div>
      )}
    </div>
  );
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
