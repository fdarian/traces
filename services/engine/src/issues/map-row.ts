import type { Issue, Occurrence } from '@traces/core';

export function mapIssueRow(row: {
  id: number;
  fingerprint: string;
  title: string;
  service: string;
  exceptionType: string;
  status: 'unresolved' | 'resolved';
  firstSeen: Date;
  lastSeen: Date;
  occurrenceCount: number;
  resolvedAt: Date | null;
}): Issue {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    service: row.service,
    exceptionType: row.exceptionType,
    status: row.status,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    occurrenceCount: row.occurrenceCount,
    resolvedAt: row.resolvedAt,
  };
}

export function mapOccurrenceRow(row: {
  id: number;
  issueId: number;
  traceId: string;
  spanId: string;
  serviceName: string;
  timestamp: Date;
  exceptionMessage: string;
  exceptionStacktrace: string | null;
  attributes: Record<string, unknown>;
}): Occurrence {
  return {
    id: row.id,
    issueId: row.issueId,
    traceId: row.traceId,
    spanId: row.spanId,
    serviceName: row.serviceName,
    timestamp: row.timestamp,
    exceptionMessage: row.exceptionMessage,
    exceptionStacktrace: row.exceptionStacktrace,
    attributes: row.attributes,
  };
}
