import { Schema } from 'effect';

export const Envelope = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(Schema.Unknown)),
    errors: Schema.optional(
      Schema.Array(Schema.Struct({ message: Schema.String })),
    ),
  }),
);

export const IsoTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
);

export const RailwayLogRow = Schema.Struct({
  timestamp: IsoTimestamp,
  message: Schema.String,
  severity: Schema.optional(Schema.NullOr(Schema.String)),
  attributes: Schema.Array(
    Schema.Struct({ key: Schema.String, value: Schema.String }),
  ),
  tags: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        deploymentId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
export type RailwayLogRow = typeof RailwayLogRow.Type;

export const RailwayHttpRow = Schema.Struct({
  timestamp: IsoTimestamp,
  method: Schema.String,
  path: Schema.String,
  httpStatus: Schema.Number,
  totalDuration: Schema.Number,
  requestId: Schema.String,
  host: Schema.String,
});
export type RailwayHttpRow = typeof RailwayHttpRow.Type;

export const Named = Schema.Struct({ id: Schema.String, name: Schema.String });

export const ProjectData = Schema.Struct({
  project: Schema.NullOr(
    Schema.Struct({
      services: Schema.Struct({
        edges: Schema.Array(Schema.Struct({ node: Named })),
      }),
      environments: Schema.Struct({
        edges: Schema.Array(Schema.Struct({ node: Named })),
      }),
    }),
  ),
});

export const DeploymentNode = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  staticUrl: Schema.optional(Schema.NullOr(Schema.String)),
  meta: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        commitHash: Schema.optional(Schema.NullOr(Schema.String)),
        commitMessage: Schema.optional(Schema.NullOr(Schema.String)),
        branch: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

export const DeploymentsData = Schema.Struct({
  deployments: Schema.Struct({
    edges: Schema.Array(Schema.Struct({ node: DeploymentNode })),
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
});

export const EnvironmentLogsData = Schema.Struct({
  environmentLogs: Schema.Array(RailwayLogRow),
});
export const DeploymentLogsData = Schema.Struct({
  deploymentLogs: Schema.Array(RailwayLogRow),
});
export const BuildLogsData = Schema.Struct({
  buildLogs: Schema.Array(RailwayLogRow),
});
export const HttpLogsData = Schema.Struct({
  httpLogs: Schema.Array(RailwayHttpRow),
});

/** Only the project id is read; `railway status --json` serializes the whole project, and the linked environment is not part of it. */
export const LinkedProject = Schema.fromJsonString(
  Schema.Struct({ id: Schema.NonEmptyString }),
);
