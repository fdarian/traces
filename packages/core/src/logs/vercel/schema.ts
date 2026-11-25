import { Schema } from 'effect';

export const ProjectResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  accountId: Schema.String,
});

export const RequestLogLine = Schema.Struct({
  level: Schema.String,
  message: Schema.String,
});

/** `new Date(...).toISOString()` throws on an unparseable value, so the row is rejected at decode time instead. */
const ParseableTimestamp = Schema.String.check(
  Schema.makeFilter(
    (text) =>
      !Number.isNaN(Date.parse(text)) || 'expected a parseable timestamp',
  ),
);

/** Same reason as `ParseableTimestamp`: an out-of-range epoch makes `toISOString()` throw. */
const EpochMs = Schema.Number.check(
  Schema.makeFilter(
    (ms) =>
      !Number.isNaN(new Date(ms).getTime()) ||
      'expected an epoch in milliseconds within the representable date range',
  ),
);

export const RequestLogRow = Schema.Struct({
  requestId: Schema.String,
  traceId: Schema.optional(Schema.NullOr(Schema.String)),
  timestamp: ParseableTimestamp,
  deploymentId: Schema.String,
  environment: Schema.String,
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  domain: Schema.optional(Schema.NullOr(Schema.String)),
  requestMethod: Schema.String,
  requestPath: Schema.String,
  statusCode: Schema.Number,
  requestDurationMs: Schema.optional(Schema.NullOr(Schema.Number)),
  logs: Schema.Array(RequestLogLine),
});
export type RequestLogRow = typeof RequestLogRow.Type;

export const RequestLogsResponse = Schema.Struct({
  rows: Schema.Array(RequestLogRow),
  hasMoreRows: Schema.Boolean,
});

export const DeploymentsResponse = Schema.Struct({
  deployments: Schema.Array(
    Schema.Struct({
      uid: Schema.String,
      readyState: Schema.String,
      target: Schema.optional(Schema.NullOr(Schema.String)),
      created: EpochMs,
      url: Schema.optional(Schema.NullOr(Schema.String)),
      meta: Schema.optional(
        Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
      ),
    }),
  ),
  pagination: Schema.Struct({
    next: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});
export type VercelDeployment =
  (typeof DeploymentsResponse.Type)['deployments'][number];

export const BuildEvent = Schema.Struct({
  id: Schema.optional(Schema.String),
  created: Schema.optional(EpochMs),
  type: Schema.String,
  text: Schema.optional(Schema.String),
  payload: Schema.optional(
    Schema.NullOr(Schema.Struct({ text: Schema.optional(Schema.String) })),
  ),
});
export type BuildEvent = typeof BuildEvent.Type;
export const BuildEventsResponse = Schema.Array(BuildEvent);
