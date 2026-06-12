import { and, eq, inArray, type Column, type SQL } from 'drizzle-orm';
import { Schema } from 'effect';
import { IssueStoreError } from './errors.js';
import type { ListIssuesFilter } from './model.js';

export function issueStoreDefect(message: string): IssueStoreError {
  return new IssueStoreError({
    cause: Schema.decodeUnknownSync(Schema.Defect)(new Error(message)),
  });
}

export function maxTimestamp(existing: Date, incoming: Date): Date {
  return incoming.getTime() > existing.getTime() ? incoming : existing;
}

export function issueListFilterConditions<
  TStatus extends Column,
  TService extends Column,
>(
  filter: ListIssuesFilter,
  columns: { readonly status: TStatus; readonly service: TService },
): Array<SQL> {
  const conditions: Array<SQL> = [];
  if (filter.status !== undefined) {
    conditions.push(eq(columns.status, filter.status));
  }
  if (filter.service !== undefined) {
    conditions.push(eq(columns.service, filter.service));
  } else if (
    filter.services !== undefined &&
    filter.services.length > 0
  ) {
    conditions.push(inArray(columns.service, [...filter.services]));
  }
  return conditions;
}

export function combineSqlConditions(
  conditions: ReadonlyArray<SQL>,
): SQL | undefined {
  if (conditions.length === 0) {
    return undefined;
  }
  if (conditions.length === 1) {
    return conditions[0];
  }
  return and(conditions[0], conditions[1], ...conditions.slice(2));
}

export function isRegressedIssue(issue: {
  readonly status: 'unresolved' | 'resolved';
  readonly resolvedAt: Date | null;
  readonly lastSeen: Date;
}): boolean {
  if (issue.status !== 'unresolved') {
    return false;
  }
  if (issue.resolvedAt === null) {
    return false;
  }
  return issue.lastSeen.getTime() > issue.resolvedAt.getTime();
}
