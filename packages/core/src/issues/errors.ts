import { Schema } from 'effect';

export class IssueStoreError extends Schema.TaggedError<IssueStoreError>()(
  'IssueStoreError',
  {
    cause: Schema.Defect(),
  },
) {}

export class IssueNotFound extends Schema.TaggedError<IssueNotFound>()(
  'IssueNotFound',
  {
    issueId: Schema.Number,
  },
) {}
