import type {
  Deployment,
  DeploymentStatus,
  LogLevel,
  LogRecord,
  LogSourceKind,
  RailwayTarget,
} from '../model.js';
import {
  decodeJsonAttribute,
  normalizeLevel,
  stripAnsi,
} from '../normalize.js';
import type {
  DeploymentNode,
  RailwayHttpRow,
  RailwayLogRow,
} from './schema.js';

export const PROVIDER = 'railway' as const;

const DEPLOYMENT_STATUS: Readonly<Record<string, DeploymentStatus>> = {
  INITIALIZING: 'queued',
  QUEUED: 'queued',
  WAITING: 'queued',
  NEEDS_APPROVAL: 'queued',
  BUILDING: 'building',
  DEPLOYING: 'deploying',
  SUCCESS: 'ready',
  FAILED: 'failed',
  CRASHED: 'crashed',
  REMOVING: 'removed',
  REMOVED: 'removed',
  SLEEPING: 'sleeping',
  SKIPPED: 'canceled',
};

export const mapRailwayStatus = (raw: string): DeploymentStatus => {
  const mapped = DEPLOYMENT_STATUS[raw];
  return mapped === undefined ? 'unknown' : mapped;
};

export const mapRailwayLog = (
  row: RailwayLogRow,
  context: {
    readonly target: RailwayTarget;
    readonly source: LogSourceKind;
    readonly deploymentId?: string;
  },
): LogRecord => {
  const attrs: Record<string, string> = {};
  let levelAttribute: string | undefined;
  for (const attribute of row.attributes) {
    const value = decodeJsonAttribute(attribute.value);
    if (attribute.key === 'level') {
      levelAttribute = value;
      continue;
    }
    attrs[attribute.key] = value;
  }
  const tagDeploymentId = row.tags?.deploymentId;
  const deploymentId =
    tagDeploymentId === null || tagDeploymentId === undefined
      ? context.deploymentId
      : tagDeploymentId;
  const severity =
    row.severity === null || row.severity === undefined
      ? levelAttribute
      : row.severity;
  return {
    ts: row.timestamp,
    service: context.target.service,
    provider: PROVIDER,
    environment: context.target.environment,
    ...(deploymentId === undefined ? {} : { deploymentId }),
    source: context.source,
    level: normalizeLevel(severity),
    message: stripAnsi(row.message),
    attrs,
  };
};

export const mapRailwayHttpLog = (
  row: RailwayHttpRow,
  context: { readonly target: RailwayTarget; readonly deploymentId: string },
): LogRecord => ({
  ts: row.timestamp,
  service: context.target.service,
  provider: PROVIDER,
  environment: context.target.environment,
  deploymentId: context.deploymentId,
  source: 'http',
  level: httpLevel(row.httpStatus),
  message: `${row.method} ${row.path} ${row.httpStatus} ${row.totalDuration}ms`,
  request: {
    method: row.method,
    path: row.path,
    status: row.httpStatus,
    durationMs: row.totalDuration,
    requestId: row.requestId,
  },
  attrs: { host: row.host },
});

const httpLevel = (status: number): LogLevel =>
  status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

export const mapRailwayDeployment = (
  node: typeof DeploymentNode.Type,
  target: RailwayTarget,
): Deployment => {
  const meta = node.meta;
  const sha = meta?.commitHash;
  const message = meta?.commitMessage;
  const branch = meta?.branch;
  const url = node.staticUrl;
  return {
    id: node.id,
    service: target.service,
    provider: PROVIDER,
    environment: target.environment,
    status: mapRailwayStatus(node.status),
    rawStatus: node.status,
    createdAt: node.createdAt,
    ...(url === null || url === undefined ? {} : { url }),
    ...(sha === null || sha === undefined
      ? {}
      : {
          commit: {
            sha,
            ...(message === null || message === undefined ? {} : { message }),
            ...(branch === null || branch === undefined ? {} : { branch }),
          },
        }),
  };
};
