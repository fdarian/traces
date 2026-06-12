import type {
  Issue,
  IssueDetail,
  ListIssuesResult,
  Occurrence,
  OccurrenceBucket,
} from '@traces/core';
import { isRegressedIssue } from '@traces/core';

export type SerializableIssue = {
  readonly id: number;
  readonly fingerprint: string;
  readonly title: string;
  readonly service: string;
  readonly exceptionType: string;
  readonly status: 'unresolved' | 'resolved';
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly occurrenceCount: number;
  readonly resolvedAt: number | null;
  readonly regressed: boolean;
};

export type SerializableOccurrence = {
  readonly id: number;
  readonly issueId: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly serviceName: string;
  readonly timestamp: number;
  readonly exceptionMessage: string;
  readonly exceptionStacktrace: string | null;
};

export type SerializableOccurrenceBucket = {
  readonly bucketStart: number;
  readonly count: number;
};

export function serializeIssue(issue: Issue): SerializableIssue {
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

export function serializeOccurrence(
  occurrence: Occurrence,
): SerializableOccurrence {
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

export function serializeOccurrenceBuckets(
  buckets: ReadonlyArray<OccurrenceBucket>,
): ReadonlyArray<SerializableOccurrenceBucket> {
  const result: Array<SerializableOccurrenceBucket> = [];
  for (const bucket of buckets) {
    result.push({
      bucketStart: bucket.bucketStart.getTime(),
      count: bucket.count,
    });
  }
  return result;
}

export function serializeListIssuesResult(result: ListIssuesResult): {
  readonly issues: ReadonlyArray<SerializableIssue>;
  readonly summary: ListIssuesResult['summary'];
} {
  const issues: Array<SerializableIssue> = [];
  for (const issue of result.issues) {
    issues.push(serializeIssue(issue));
  }
  return {
    issues,
    summary: result.summary,
  };
}

export function serializeIssueDetail(detail: IssueDetail): {
  readonly issue: SerializableIssue;
  readonly latestOccurrence: SerializableOccurrence | null;
} {
  return {
    issue: serializeIssue(detail.issue),
    latestOccurrence:
      detail.latestOccurrence === null
        ? null
        : serializeOccurrence(detail.latestOccurrence),
  };
}
