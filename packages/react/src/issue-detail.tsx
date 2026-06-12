import { ServiceBadge } from './service-badge.js';
import { Sparkline } from './sparkline.js';
import { StacktraceBlock } from './stacktrace-block.js';
import { StatusBadge } from './status-badge.js';

export type IssueDetailData = {
  readonly id: number;
  readonly exceptionType: string;
  readonly title: string;
  readonly service: string;
  readonly status: 'unresolved' | 'resolved';
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly occurrenceCount: number;
  readonly resolvedAt: number | null;
  readonly regressed: boolean;
  readonly sparklineCounts: ReadonlyArray<number>;
  readonly latestMessage: string;
  readonly latestStacktrace: string;
};

export type IssueOccurrenceRow = {
  readonly id: number;
  readonly timestamp: number;
  readonly exceptionMessage: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly serviceName: string;
};

export function IssueDetail(props: {
  readonly issue: IssueDetailData;
  readonly occurrences: ReadonlyArray<IssueOccurrenceRow>;
  readonly page: number;
  readonly totalPages: number;
  readonly isLoadingOccurrences: boolean;
  readonly onPageChange: (page: number) => void;
  readonly onResolve: () => void;
  readonly onUnresolve: () => void;
  readonly isResolving: boolean;
  readonly getTraceHref: (traceId: string, spanId: string) => string;
}) {
  const issue = props.issue;
  const message = condensedMessage(issue.title, issue.exceptionType);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 border-b border-border-default pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded bg-bg-inset px-1.5 py-0.5 font-data text-data text-text-primary">
            {issue.exceptionType}
          </span>
          <h1 className="text-body text-text-primary">{message}</h1>
          <StatusBadge
            status={issue.status === 'resolved' ? 'resolved' : 'error'}
            label={issue.status}
          />
          {issue.regressed && (
            <span className="inline-flex items-center gap-1 text-label uppercase tracking-wide text-status-warn">
              <span className="inline-block h-1 w-1 rounded-full bg-status-warn" />
              regressed {relativeTime(issue.lastSeen)}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 text-label uppercase tracking-wide text-text-tertiary">
          <ServiceBadge name={issue.service} />
          <span>
            {issue.occurrenceCount} occurrence
            {issue.occurrenceCount === 1 ? '' : 's'}
          </span>
          <span title={new Date(issue.firstSeen).toISOString()}>
            first {relativeTime(issue.firstSeen)}
          </span>
          <span title={new Date(issue.lastSeen).toISOString()}>
            last {relativeTime(issue.lastSeen)}
          </span>
        </div>

        <div className="flex items-center gap-4">
          <Sparkline
            counts={issue.sparklineCounts}
            color="var(--status-error)"
            size="lg"
          />
          {issue.status === 'unresolved' ? (
            <button
              type="button"
              onClick={props.onResolve}
              disabled={props.isResolving}
              className="rounded bg-accent px-3 py-1.5 text-body text-accent-foreground transition-colors duration-120 hover:opacity-90 disabled:opacity-60"
            >
              {props.isResolving ? 'resolving…' : 'resolve'}
            </button>
          ) : (
            <button
              type="button"
              onClick={props.onUnresolve}
              disabled={props.isResolving}
              className="rounded bg-accent px-3 py-1.5 text-body text-accent-foreground transition-colors duration-120 hover:opacity-90 disabled:opacity-60"
            >
              {props.isResolving ? 'updating…' : 'unresolve'}
            </button>
          )}
        </div>
      </header>

      {issue.latestStacktrace.length > 0 && (
        <section>
          <h2 className="mb-2 text-label uppercase tracking-wide text-text-tertiary">
            latest stacktrace
          </h2>
          <StacktraceBlock
            type={issue.exceptionType}
            message={issue.latestMessage}
            stacktrace={issue.latestStacktrace}
          />
        </section>
      )}

      <section>
        <h2 className="mb-2 text-label uppercase tracking-wide text-text-tertiary">
          occurrences
        </h2>

        <div className="flex h-8 items-center gap-3 border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          <span className="w-28 shrink-0">timestamp</span>
          <span className="min-w-0 flex-1">message</span>
          <span className="w-36 shrink-0">trace</span>
          <span className="w-20 shrink-0">service</span>
        </div>

        {props.occurrences.map((occurrence) => (
          <div
            key={occurrence.id}
            className="flex h-8 items-center gap-3 border-b border-border-subtle px-3 transition-colors duration-120 hover:bg-bg-raised"
          >
            <span
              className="w-28 shrink-0 font-data text-data text-text-tertiary"
              title={new Date(occurrence.timestamp).toISOString()}
            >
              {relativeTime(occurrence.timestamp)}
            </span>
            <span className="min-w-0 flex-1 truncate text-body text-text-primary">
              {occurrence.exceptionMessage}
            </span>
            <a
              href={props.getTraceHref(occurrence.traceId, occurrence.spanId)}
              className="w-36 shrink-0 truncate font-data text-data text-accent transition-colors duration-120 hover:text-text-primary"
            >
              {shortTraceId(occurrence.traceId)}
            </a>
            <div className="w-20 shrink-0">
              <ServiceBadge name={occurrence.serviceName} />
            </div>
          </div>
        ))}

        {props.totalPages > 1 && (
          <div className="flex h-10 items-center justify-between border-b border-border-subtle px-3">
            <button
              type="button"
              onClick={() => props.onPageChange(props.page - 1)}
              disabled={props.page <= 1 || props.isLoadingOccurrences}
              className="text-body text-text-secondary transition-colors duration-120 hover:text-text-primary disabled:text-text-tertiary"
            >
              previous
            </button>
            <span className="font-data text-data text-text-tertiary">
              page {props.page} of {props.totalPages}
            </span>
            <button
              type="button"
              onClick={() => props.onPageChange(props.page + 1)}
              disabled={
                props.page >= props.totalPages || props.isLoadingOccurrences
              }
              className="text-body text-text-secondary transition-colors duration-120 hover:text-text-primary disabled:text-text-tertiary"
            >
              next
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function condensedMessage(title: string, exceptionType: string): string {
  const prefix = `${exceptionType}: `;
  if (title.startsWith(prefix)) {
    return title.slice(prefix.length);
  }
  return title;
}

function shortTraceId(traceId: string): string {
  if (traceId.length <= 12) {
    return traceId;
  }
  return `${traceId.slice(0, 8)}…`;
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
