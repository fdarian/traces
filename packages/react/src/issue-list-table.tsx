import { EmptyState } from './empty-state.js';
import { ServiceBadge } from './service-badge.js';
import { SkeletonRow } from './skeleton-row.js';
import { Sparkline } from './sparkline.js';
import { StatusBadge } from './status-badge.js';

export type IssueListRow = {
  readonly id: number;
  readonly exceptionType: string;
  readonly title: string;
  readonly service: string;
  readonly occurrenceCount: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly status: 'unresolved' | 'resolved';
  readonly resolvedAt: number | null;
  readonly sparklineCounts: ReadonlyArray<number>;
  readonly regressed: boolean;
};

export function IssueListTable(props: {
  readonly issues: ReadonlyArray<IssueListRow>;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly getIssueHref: (issueId: number) => string;
  readonly onResolve: (issueId: number) => void;
  readonly resolvingIssueId: number | null;
}) {
  if (props.error !== null) {
    return (
      <div className="px-4 py-12 text-body text-status-error">
        failed to load issues
      </div>
    );
  }

  if (props.isLoading && props.issues.length === 0) {
    return (
      <div>
        {Array.from({ length: 5 }).map((_, index) => (
          <SkeletonRow key={index} />
        ))}
      </div>
    );
  }

  if (props.issues.length === 0) {
    return <EmptyState message="no issues in this filter" />;
  }

  return (
    <div>
      <div className="flex h-8 items-center gap-3 border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        <span className="min-w-0 flex-1 text-left">issue</span>
        <span className="w-20 shrink-0">service</span>
        <span className="w-12 shrink-0 text-right">count</span>
        <span className="w-20 shrink-0">24h</span>
        <span className="w-20 shrink-0 text-right">first</span>
        <span className="w-20 shrink-0 text-right">last</span>
        <span className="w-16 shrink-0" />
      </div>

      {props.issues.map((issue) => (
        <IssueRow
          key={issue.id}
          issue={issue}
          getIssueHref={props.getIssueHref}
          onResolve={props.onResolve}
          isResolving={props.resolvingIssueId === issue.id}
        />
      ))}
    </div>
  );
}

function IssueRow(props: {
  readonly issue: IssueListRow;
  readonly getIssueHref: (issueId: number) => string;
  readonly onResolve: (issueId: number) => void;
  readonly isResolving: boolean;
}) {
  const issue = props.issue;
  const message = condensedMessage(issue.title, issue.exceptionType);

  return (
    <div className="group relative flex h-8 items-center gap-3 border-b border-border-subtle px-3 transition-colors duration-120 hover:bg-bg-raised">
      <a
        href={props.getIssueHref(issue.id)}
        className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
      >
        <span className="inline-flex shrink-0 items-center rounded bg-bg-inset px-1.5 py-0.5 font-data text-data text-text-primary">
          {issue.exceptionType}
        </span>
        <span className="truncate text-body text-text-primary">{message}</span>
        {issue.regressed && (
          <span className="inline-flex shrink-0 items-center gap-1 text-label uppercase tracking-wide text-status-warn">
            <span className="inline-block h-1 w-1 rounded-full bg-status-warn" />
            regressed {relativeTime(issue.lastSeen)}
          </span>
        )}
      </a>

      <div className="w-20 shrink-0">
        <ServiceBadge name={issue.service} />
      </div>

      <span className="w-12 shrink-0 text-right font-data text-data text-text-primary">
        {issue.occurrenceCount}
      </span>

      <div className="flex w-20 shrink-0 items-center">
        <Sparkline
          counts={issue.sparklineCounts}
          color="var(--status-error)"
          size="sm"
        />
      </div>

      <span
        className="w-20 shrink-0 text-right font-data text-data text-text-tertiary"
        title={new Date(issue.firstSeen).toISOString()}
      >
        {relativeTime(issue.firstSeen)}
      </span>

      <span
        className="w-20 shrink-0 text-right font-data text-data text-text-tertiary"
        title={new Date(issue.lastSeen).toISOString()}
      >
        {relativeTime(issue.lastSeen)}
      </span>

      <div className="flex w-16 shrink-0 justify-end">
        {issue.status === 'unresolved' && (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onResolve(issue.id);
            }}
            disabled={props.isResolving}
            className="pointer-events-none rounded px-1.5 py-0.5 text-label uppercase tracking-wide text-text-secondary opacity-0 transition-all duration-120 hover:text-text-primary group-hover:pointer-events-auto group-hover:opacity-100 disabled:text-text-tertiary"
          >
            {props.isResolving ? '…' : 'resolve'}
          </button>
        )}
        {issue.status === 'resolved' && (
          <StatusBadge status="resolved" />
        )}
      </div>
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