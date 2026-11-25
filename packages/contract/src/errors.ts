import { Schema } from 'effect';

export const jaegerErrors = {
  JAEGER_UNREACHABLE: {
    status: 503,
    message: 'Jaeger is unreachable',
  },
  JAEGER_BAD_RESPONSE: {
    status: 502,
    message: 'Jaeger returned an unexpected response',
  },
  JAEGER_UNAUTHORIZED: {
    status: 502,
    message: 'Jaeger rejected the configured credentials',
  },
} as const;

export const traceNotFoundErrors = {
  TRACE_NOT_FOUND: {
    status: 404,
    message: 'Trace not found',
    data: Schema.Struct({ traceId: Schema.String }),
  },
} as const;

export const issueNotFoundErrors = {
  ISSUE_NOT_FOUND: {
    status: 404,
    message: 'Issue not found',
    data: Schema.Struct({ issueId: Schema.Number }),
  },
} as const;
