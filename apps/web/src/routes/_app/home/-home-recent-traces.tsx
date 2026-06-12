import { Duration, ServiceBadge } from '@traces/react';
import type { SerializableTraceSummary } from '#/server/home-recent-error-traces.functions';

export function HomeRecentTraces(props: {
  readonly traces: ReadonlyArray<SerializableTraceSummary>;
  readonly isLoading: boolean;
  readonly getTraceHref: (traceId: string) => string;
}) {
  if (props.isLoading) {
    return (
      <div className="rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          recent error traces
        </div>
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex h-8 items-center gap-3 border-b border-border-subtle px-3"
          >
            <div className="h-3 w-32 animate-shimmer rounded bg-bg-raised" />
            <div className="h-3 w-16 animate-shimmer rounded bg-bg-raised" />
          </div>
        ))}
      </div>
    );
  }

  if (props.traces.length === 0) {
    return (
      <div className="rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          recent error traces
        </div>
        <div className="flex h-32 items-center justify-center text-body text-text-secondary">
          no error traces in this range
        </div>
      </div>
    );
  }

  return (
    <div className="rounded border border-border-subtle bg-bg-subtle">
      <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        recent error traces
      </div>
      <div className="flex h-8 items-center gap-3 border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        <span className="min-w-0 flex-1 text-left">operation</span>
        <span className="w-20 shrink-0">service</span>
        <span className="w-16 shrink-0 text-right">duration</span>
        <span className="w-20 shrink-0 text-right">time</span>
      </div>
      {props.traces.map((trace) => (
        <TraceRow
          key={trace.traceId}
          trace={trace}
          getTraceHref={props.getTraceHref}
        />
      ))}
    </div>
  );
}

function TraceRow(props: {
  readonly trace: SerializableTraceSummary;
  readonly getTraceHref: (traceId: string) => string;
}) {
  const trace = props.trace;
  const startMs = Number(BigInt(trace.startTimeUnixNano) / BigInt(1000000));

  return (
    <a
      href={props.getTraceHref(trace.traceId)}
      className="flex h-8 items-center gap-3 border-b border-border-subtle px-3 transition-colors duration-120 hover:bg-bg-raised"
    >
      <span className="min-w-0 flex-1 truncate text-body text-text-primary">
        {trace.rootOperation}
      </span>

      <div className="w-20 shrink-0">
        <ServiceBadge name={trace.rootService} />
      </div>

      <span className="w-16 shrink-0 text-right font-data text-data text-text-primary">
        <Duration ms={trace.durationMs} />
      </span>

      <span className="w-20 shrink-0 text-right font-data text-data text-text-tertiary">
        {relativeTime(startMs)}
      </span>
    </a>
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
