import type {
  Issue as IssueWire,
  Occurrence as OccurrenceWire,
} from '@traces/contract';
import type {
  Issue,
  IssueDetail,
  ListIssuesResult,
  Occurrence,
  OccurrenceBucket,
  TopIssue,
} from '@traces/core';
import { isRegressedIssue } from '@traces/core';

export function serializeIssue(issue: Issue): IssueWire {
  return {
    id: issue.id,
    fingerprint: issue.fingerprint,
    title: issue.title,
    service: issue.service,
    exceptionType: issue.exceptionType,
    status: issue.status,
    firstSeen: issue.firstSeen.getTime(),
    lastSeen: issue.lastSeen.getTime(),
    occurrenceCount: issue.occurrenceCount,
    resolvedAt: issue.resolvedAt?.getTime() ?? null,
    regressed: isRegressedIssue(issue),
  };
}

export function serializeOccurrence(occurrence: Occurrence): OccurrenceWire {
  return {
    id: occurrence.id,
    issueId: occurrence.issueId,
    traceId: occurrence.traceId,
    spanId: occurrence.spanId,
    serviceName: occurrence.serviceName,
    timestamp: occurrence.timestamp.getTime(),
    exceptionMessage: occurrence.exceptionMessage,
    exceptionStacktrace: occurrence.exceptionStacktrace,
  };
}

// Also used for the home trend, whose buckets have the same shape.
export function serializeOccurrenceBuckets(
  buckets: ReadonlyArray<OccurrenceBucket>,
): ReadonlyArray<{ readonly bucketStart: number; readonly count: number }> {
  const result: Array<{
    readonly bucketStart: number;
    readonly count: number;
  }> = [];
  for (const bucket of buckets) {
    result.push({
      bucketStart: bucket.bucketStart.getTime(),
      count: bucket.count,
    });
  }
  return result;
}

export function serializeListIssuesResult(result: ListIssuesResult): {
  readonly issues: ReadonlyArray<IssueWire>;
  readonly summary: ListIssuesResult['summary'];
} {
  const issues: Array<IssueWire> = [];
  for (const issue of result.issues) {
    issues.push(serializeIssue(issue));
  }
  return {
    issues,
    summary: result.summary,
  };
}

export function serializeIssueDetail(detail: IssueDetail): {
  readonly issue: IssueWire;
  readonly latestOccurrence: OccurrenceWire | null;
} {
  return {
    issue: serializeIssue(detail.issue),
    latestOccurrence:
      detail.latestOccurrence === null
        ? null
        : serializeOccurrence(detail.latestOccurrence),
  };
}

export function serializeTopIssue(issue: TopIssue) {
  return {
    id: issue.id,
    title: issue.title,
    service: issue.service,
    occurrenceCount: issue.occurrenceCount,
    lastSeen: issue.lastSeen.getTime(),
  };
}
