import { Effect, Schema } from 'effect';
import { InvalidCursor } from './errors.js';
import { Provider } from './provider.js';

export { Provider };

export const LogSourceKind = Schema.Literals(['runtime', 'build', 'http']);
export type LogSourceKind = typeof LogSourceKind.Type;

export const LogLevel = Schema.Literals([
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'unknown',
]);
export type LogLevel = typeof LogLevel.Type;

export const LogRequest = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  status: Schema.Number,
  durationMs: Schema.optional(Schema.Number),
  requestId: Schema.optional(Schema.String),
});
export type LogRequest = typeof LogRequest.Type;

export const LogRecord = Schema.Struct({
  ts: Schema.String,
  service: Schema.String,
  provider: Provider,
  environment: Schema.String,
  deploymentId: Schema.optional(Schema.String),
  source: LogSourceKind,
  level: LogLevel,
  message: Schema.String,
  request: Schema.optional(LogRequest),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  attrs: Schema.Record(Schema.String, Schema.Unknown),
});
export type LogRecord = typeof LogRecord.Type;

export const DeploymentStatus = Schema.Literals([
  'queued',
  'building',
  'deploying',
  'ready',
  'failed',
  'canceled',
  'crashed',
  'removed',
  'sleeping',
  'unknown',
]);
export type DeploymentStatus = typeof DeploymentStatus.Type;

export const DeploymentCommit = Schema.Struct({
  sha: Schema.String,
  message: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
});
export type DeploymentCommit = typeof DeploymentCommit.Type;

export const Deployment = Schema.Struct({
  id: Schema.String,
  service: Schema.String,
  provider: Provider,
  environment: Schema.String,
  status: DeploymentStatus,
  rawStatus: Schema.String,
  createdAt: Schema.String,
  url: Schema.optional(Schema.String),
  commit: Schema.optional(DeploymentCommit),
});
export type Deployment = typeof Deployment.Type;

export interface RailwayTarget {
  readonly provider: 'railway';
  readonly service: string;
  readonly project: string;
  readonly serviceName: string;
  readonly environment: string;
}

export interface VercelTarget {
  readonly provider: 'vercel';
  readonly service: string;
  readonly project: string;
  readonly team?: string;
  /** `production` or `preview`. */
  readonly environment: string;
}

export type ServiceTarget = RailwayTarget | VercelTarget;

/**
 * Provider-specific paging state. `since` is carried so that a `more:` command
 * pages through a stable window even though relative `--since 1h` drifts.
 */
export const Cursor = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('railway-time'),
    since: Schema.optional(Schema.Number),
    before: Schema.String,
    seen: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('railway-relay'),
    after: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('jaeger-time'),
    since: Schema.Number,
    before: Schema.String,
    seen: Schema.Array(Schema.String),
    // Only error scans set it: how their earlier pages found error traces.
    mode: Schema.optional(Schema.Literals(['filtered', 'client'])),
  }),
  Schema.Struct({
    kind: Schema.Literal('vercel-page'),
    since: Schema.Number,
    until: Schema.Number,
    page: Schema.Number,
    skip: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal('vercel-until'),
    until: Schema.Number,
    seen: Schema.Array(Schema.String),
  }),
]);
export type Cursor = typeof Cursor.Type;

const CursorJson = Schema.fromJsonString(Cursor);

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(Schema.encodeSync(CursorJson)(cursor), 'utf8').toString(
    'base64url',
  );

export const decodeCursor = (encoded: string) =>
  Schema.decodeUnknownEffect(CursorJson)(
    Buffer.from(encoded, 'base64url').toString('utf8'),
  ).pipe(Effect.mapError((cause) => new InvalidCursor({ cause })));

export interface LogQuery {
  readonly since?: Date;
  readonly until?: Date;
  /** Empty means every level. */
  readonly levels: ReadonlyArray<LogLevel>;
  readonly grep?: string;
  /** A deployment id, or `latest`. */
  readonly deploymentId?: string;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface LogPage {
  readonly records: ReadonlyArray<LogRecord>;
  /** Present when older records exist beyond this page. */
  readonly next?: Cursor;
}

export interface DeploymentQuery {
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface DeploymentPage {
  readonly deployments: ReadonlyArray<Deployment>;
  readonly next?: Cursor;
}
