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

export const RequestLogRow = Schema.Struct({
  requestId: Schema.String,
  timestamp: Schema.String,
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
      created: Schema.Number,
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
  created: Schema.optional(Schema.Number),
  type: Schema.String,
  text: Schema.optional(Schema.String),
  payload: Schema.optional(
    Schema.NullOr(Schema.Struct({ text: Schema.optional(Schema.String) })),
  ),
});
export type BuildEvent = typeof BuildEvent.Type;
export const BuildEventsResponse = Schema.Array(BuildEvent);
