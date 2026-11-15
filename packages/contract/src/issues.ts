import { oc } from '@orpc/contract';
import { Schema } from 'effect';
import { issueNotFoundErrors } from './errors.js';

export const Issue = Schema.Struct({
  id: Schema.Number,
  fingerprint: Schema.String,
  title: Schema.String,
  service: Schema.String,
  exceptionType: Schema.String,
  status: Schema.Literals(['unresolved', 'resolved']),
  firstSeen: Schema.Number,
  lastSeen: Schema.Number,
  occurrenceCount: Schema.Number,
  resolvedAt: Schema.NullOr(Schema.Number),
  regressed: Schema.Boolean,
});

export const Occurrence = Schema.Struct({
  id: Schema.Number,
  issueId: Schema.Number,
  traceId: Schema.String,
  spanId: Schema.String,
  serviceName: Schema.String,
  timestamp: Schema.Number,
  exceptionMessage: Schema.String,
  exceptionStacktrace: Schema.NullOr(Schema.String),
});

export const OccurrenceBucket = Schema.Struct({
  bucketStart: Schema.Number,
  count: Schema.Number,
});

export const IssueWithHistogram = Schema.Struct({
  ...Issue.fields,
  histogram: Schema.Array(OccurrenceBucket),
});

export const ListIssuesInput = Schema.Struct({
  status: Schema.Literals(['unresolved', 'resolved']),
  services: Schema.optional(Schema.Array(Schema.String)),
});

export const ListIssuesResult = Schema.Struct({
  issues: Schema.Array(IssueWithHistogram),
  summary: Schema.Struct({
    totalCount: Schema.Number,
    serviceCount: Schema.Number,
  }),
});

export const IssueIdInput = Schema.Struct({
  issueId: Schema.Number,
});

export const GetIssueInput = Schema.Struct({
  issueId: Schema.Number,
  page: Schema.optional(Schema.Number),
});

export const GetIssueResult = Schema.Struct({
  issue: Issue,
  latestOccurrence: Schema.NullOr(Occurrence),
  histogram: Schema.Array(OccurrenceBucket),
  occurrences: Schema.Array(Occurrence),
  page: Schema.Number,
  pageSize: Schema.Number,
  totalCount: Schema.Number,
});

export const IssueMutationResult = Schema.Struct({
  ok: Schema.Literal(true),
});

export type Issue = typeof Issue.Type;
export type Occurrence = typeof Occurrence.Type;
export type OccurrenceBucket = typeof OccurrenceBucket.Type;
export type IssueWithHistogram = typeof IssueWithHistogram.Type;
export type ListIssuesInput = typeof ListIssuesInput.Type;
export type ListIssuesResult = typeof ListIssuesResult.Type;
export type IssueIdInput = typeof IssueIdInput.Type;
export type GetIssueInput = typeof GetIssueInput.Type;
export type GetIssueResult = typeof GetIssueResult.Type;
export type IssueMutationResult = typeof IssueMutationResult.Type;

export const issues = {
  list: oc.input(ListIssuesInput).output(ListIssuesResult),
  get: oc
    .errors(issueNotFoundErrors)
    .input(GetIssueInput)
    .output(GetIssueResult),
  resolve: oc
    .errors(issueNotFoundErrors)
    .input(IssueIdInput)
    .output(IssueMutationResult),
  unresolve: oc
    .errors(issueNotFoundErrors)
    .input(IssueIdInput)
    .output(IssueMutationResult),
};
