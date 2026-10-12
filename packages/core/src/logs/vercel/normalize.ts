import { Option } from 'effect';
import type {
  Deployment,
  DeploymentStatus,
  LogLevel,
  LogRecord,
  VercelTarget,
} from '../model.js';
import { normalizeLevel, stripAnsi } from '../normalize.js';
import type { BuildEvent, RequestLogRow, VercelDeployment } from './schema.js';

export const PROVIDER = 'vercel' as const;

const DEPLOYMENT_STATUS: Readonly<Record<string, DeploymentStatus>> = {
  QUEUED: 'queued',
  INITIALIZING: 'queued',
  BUILDING: 'building',
  READY: 'ready',
  ERROR: 'failed',
  CANCELED: 'canceled',
  DELETED: 'removed',
};

export const mapVercelStatus = (raw: string): DeploymentStatus => {
  const mapped = DEPLOYMENT_STATUS[raw];
  return mapped === undefined ? 'unknown' : mapped;
};

const COMMIT_PROVIDERS = ['github', 'gitlab', 'bitbucket'] as const;

const metaString = (
  meta: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = meta[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const mapVercelDeployment = (
  deployment: VercelDeployment,
  target: VercelTarget,
): Deployment => {
  const meta = deployment.meta ?? {};
  let sha: string | undefined;
  let message: string | undefined;
  let branch: string | undefined;
  for (const prefix of COMMIT_PROVIDERS) {
    sha = metaString(meta, `${prefix}CommitSha`);
    if (sha !== undefined) {
      message = metaString(meta, `${prefix}CommitMessage`);
      branch = metaString(meta, `${prefix}CommitRef`);
      break;
    }
  }
  const url = deployment.url;
  return {
    id: deployment.uid,
    service: target.service,
    provider: PROVIDER,
    environment: deployment.target ?? 'preview',
    status: mapVercelStatus(deployment.readyState),
    rawStatus: deployment.readyState,
    createdAt: new Date(deployment.created).toISOString(),
    ...(url === null || url === undefined ? {} : { url }),
    ...(sha === undefined
      ? {}
      : {
          commit: {
            sha,
            ...(message === undefined ? {} : { message }),
            ...(branch === undefined ? {} : { branch }),
          },
        }),
  };
};

const httpLevel = (status: number): LogLevel =>
  status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

const requestOf = (row: RequestLogRow) => ({
  method: row.requestMethod,
  path: row.requestPath,
  status: row.statusCode,
  ...(row.requestDurationMs === null || row.requestDurationMs === undefined
    ? {}
    : { durationMs: row.requestDurationMs }),
  requestId: row.requestId,
});

const rowAttrs = (row: RequestLogRow): Record<string, string> => {
  const attrs: Record<string, string> = {};
  if (row.domain) attrs.domain = row.domain;
  if (row.branch) attrs.branch = row.branch;
  return attrs;
};

/** One record per log line, newest first, so the caller can take a prefix. */
export const mapRuntimeRow = (
  row: RequestLogRow,
  target: VercelTarget,
): ReadonlyArray<LogRecord> =>
  row.logs
    .map(
      (line): LogRecord => ({
        ts: new Date(row.timestamp).toISOString(),
        service: target.service,
        provider: PROVIDER,
        environment: row.environment,
        deploymentId: row.deploymentId,
        source: 'runtime',
        level: normalizeLevel(line.level),
        message: stripAnsi(line.message),
        request: requestOf(row),
        attrs: rowAttrs(row),
      }),
    )
    .reverse();

export const mapHttpRow = (
  row: RequestLogRow,
  target: VercelTarget,
): ReadonlyArray<LogRecord> => [
  {
    ts: new Date(row.timestamp).toISOString(),
    service: target.service,
    provider: PROVIDER,
    environment: row.environment,
    deploymentId: row.deploymentId,
    source: 'http',
    level: httpLevel(row.statusCode),
    message: `${row.requestMethod} ${row.requestPath} ${row.statusCode}${
      row.requestDurationMs === null || row.requestDurationMs === undefined
        ? ''
        : ` ${row.requestDurationMs}ms`
    }`,
    request: requestOf(row),
    attrs: rowAttrs(row),
  },
];

export const mapBuildEvent = (
  event: BuildEvent,
  context: { readonly target: VercelTarget; readonly deploymentId: string },
): Option.Option<LogRecord> => {
  const text = event.text ?? event.payload?.text;
  if (event.created === undefined || text === undefined) return Option.none();
  return Option.some({
    ts: new Date(event.created).toISOString(),
    service: context.target.service,
    provider: PROVIDER,
    environment: context.target.environment,
    deploymentId: context.deploymentId,
    source: 'build',
    level:
      event.type === 'fatal'
        ? 'fatal'
        : event.type === 'stderr'
          ? 'error'
          : 'info',
    message: stripAnsi(text),
    attrs: { type: event.type },
  });
};
