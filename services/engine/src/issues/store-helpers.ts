import type { ListIssuesFilter } from '@traces/core';
import { and, type Column, eq, inArray, type SQL } from 'drizzle-orm';
import { Effect } from 'effect';
import { IssueStoreError } from '#/issues/errors';

export function issueStoreDefect(message: string): IssueStoreError {
  return new IssueStoreError({
    cause: new Error(message),
  });
}

export function wrapStoreError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, IssueStoreError, R> {
  return Effect.mapError(effect, (cause) => new IssueStoreError({ cause }));
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
  } else if (filter.services !== undefined && filter.services.length > 0) {
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
