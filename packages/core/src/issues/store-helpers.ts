import { Schema } from 'effect';
import { IssueStoreError } from './errors.js';

export function issueStoreDefect(message: string): IssueStoreError {
  return new IssueStoreError({
    cause: Schema.decodeUnknownSync(Schema.Defect)(new Error(message)),
  });
}

export function maxTimestamp(existing: Date, incoming: Date): Date {
  return incoming.getTime() > existing.getTime() ? incoming : existing;
}
