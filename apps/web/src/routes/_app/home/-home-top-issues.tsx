import { Sparkline, StatusBadge } from '@traces/react';
import type { SerializableTopIssue } from '#/server/home-top-issues.functions';

const HOUR_MS = 60 * 60 * 1000;
const SPARKLINE_SLOTS = 24;

export function HomeTopIssues(props: {
  readonly issues: ReadonlyArray<SerializableTopIssue>;
  readonly histograms: ReadonlyMap<
    number,
    ReadonlyArray<{ bucketStart: number; count: number }>
  >;
  readonly isLoading: boolean;
  readonly getIssueHref: (issueId: number) => string;
  readonly getIssuesHref: () => string;
}) {
  if (props.isLoading) {
    return (
      <div className="rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          top unresolved issues
        </div>
        {Array.from({ length: 5 }).map((_, index) => (
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

  if (props.issues.length === 0) {
    return (
      <div className="rounded border border-border-subtle bg-bg-subtle">
        <div className="flex h-8 items-center border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
          top unresolved issues
        </div>
        <div className="flex h-32 items-center justify-center text-body text-text-secondary">
          no unresolved issues
        </div>
      </div>
    );
  }

  return (
    <div className="rounded border border-border-subtle bg-bg-subtle">
      <div className="flex h-8 items-center justify-between border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        <span>top unresolved issues</span>
        <a
          href={props.getIssuesHref()}
          className="text-accent transition-colors duration-120 hover:text-text-primary"
        >
          view all →
        </a>
      </div>
      <div className="flex h-8 items-center gap-3 border-b border-border-default px-3 text-label uppercase tracking-wide text-text-tertiary">
        <span className="min-w-0 flex-1 text-left">issue</span>
        <span className="w-20 shrink-0">service</span>
        <span className="w-12 shrink-0 text-right">count</span>
        <span className="w-20 shrink-0">24h</span>
        <span className="w-20 shrink-0 text-right">last</span>
      </div>
      {props.issues.map((issue) => (
        <IssueRow
          key={issue.id}
          issue={issue}
          histogram={props.histograms.get(issue.id) ?? []}
          getIssueHref={props.getIssueHref}
        />
      ))}
    </div>
  );
}

function IssueRow(props: {
  readonly issue: SerializableTopIssue;
  readonly histogram: ReadonlyArray<{ bucketStart: number; count: number }>;
  readonly getIssueHref: (issueId: number) => string;
}) {
  const issue = props.issue;
  const windowEnd = Date.now();
  const counts = fillHistogramCounts(props.histogram, windowEnd);

  return (
    <a
      href={props.getIssueHref(issue.id)}
      className="flex h-8 items-center gap-3 border-b border-border-subtle px-3 transition-colors duration-120 hover:bg-bg-raised"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <StatusBadge status="error" />
        <span className="truncate text-body text-text-primary">
          {issue.title}
        </span>
      </div>

      <span className="w-20 shrink-0 text-body text-text-secondary">
        {issue.service}
      </span>

      <span className="w-12 shrink-0 text-right font-data text-data text-text-primary">
        {issue.occurrenceCount}
      </span>

      <div className="flex w-20 shrink-0 items-center">
        <Sparkline counts={counts} color="var(--status-error)" size="sm" />
      </div>

      <span className="w-20 shrink-0 text-right font-data text-data text-text-tertiary">
        {relativeTime(issue.lastSeen)}
      </span>
    </a>
  );
}

function fillHistogramCounts(
  buckets: ReadonlyArray<{ bucketStart: number; count: number }>,
  windowEnd: number,
): ReadonlyArray<number> {
  const counts = Array.from({ length: SPARKLINE_SLOTS }, () => 0);
  const windowStart = windowEnd - SPARKLINE_SLOTS * HOUR_MS;

  for (const bucket of buckets) {
    const offset = bucket.bucketStart - windowStart;
    const index = Math.floor(offset / HOUR_MS);
    if (index >= 0 && index < SPARKLINE_SLOTS) {
      counts[index] = bucket.count;
    }
  }

  return counts;
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
