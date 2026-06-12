import { Context, type Effect } from 'effect';
import type { IssueNotFound, IssueStoreError } from './errors.js';
import type {
  Issue,
  ListIssuesFilter,
  Occurrence,
  UpsertOccurrenceInput,
} from './model.js';

export interface IssueStore {
  readonly upsertOccurrence: (
    input: UpsertOccurrenceInput,
  ) => Effect.Effect<void, IssueStoreError, never>;
  readonly resolveIssue: (
    issueId: number,
  ) => Effect.Effect<void, IssueStoreError | IssueNotFound, never>;
  readonly unresolveIssue: (
    issueId: number,
  ) => Effect.Effect<void, IssueStoreError | IssueNotFound, never>;
  readonly listIssues: (
    filter: ListIssuesFilter,
  ) => Effect.Effect<ReadonlyArray<Issue>, IssueStoreError, never>;
  readonly getIssue: (
    issueId: number,
  ) => Effect.Effect<Issue, IssueStoreError | IssueNotFound, never>;
  readonly getIssueOccurrences: (
    issueId: number,
  ) => Effect.Effect<ReadonlyArray<Occurrence>, IssueStoreError, never>;
  readonly getIngestCursor: (
    service: string,
  ) => Effect.Effect<Date | null, IssueStoreError, never>;
  readonly setIngestCursor: (
    service: string,
    cursorEnd: Date,
  ) => Effect.Effect<void, IssueStoreError, never>;
}

export const IssueStore = Context.GenericTag<IssueStore>('traces/IssueStore');

// Lifetime total per issue — incremented once per real occurrence, never
// decremented when retention prunes stored rows below this count.
export const MAX_OCCURRENCES_PER_ISSUE = 1000;
