export type IssueStatus = 'unresolved' | 'resolved';

export interface Issue {
  readonly id: number;
  readonly fingerprint: string;
  readonly title: string;
  readonly service: string;
  readonly exceptionType: string;
  readonly status: IssueStatus;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly occurrenceCount: number;
  readonly resolvedAt: Date | null;
}

export interface Occurrence {
  readonly id: number;
  readonly issueId: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly serviceName: string;
  readonly timestamp: Date;
  readonly exceptionMessage: string;
  readonly exceptionStacktrace: string | null;
  readonly attributes: Record<string, unknown>;
}

export interface UpsertOccurrenceInput {
  readonly fingerprint: string;
  readonly title: string;
  readonly service: string;
  readonly exceptionType: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly serviceName: string;
  readonly timestamp: number;
  readonly exceptionMessage: string;
  readonly exceptionStacktrace?: string;
  readonly attributes: Record<string, unknown>;
}

export interface ListIssuesFilter {
  readonly status?: IssueStatus;
  readonly service?: string;
}
