import { Effect } from 'effect';
import { type ProviderError, ProviderNotFound } from '../errors.js';
import type {
  Cursor,
  DeploymentPage,
  DeploymentQuery,
  LogPage,
  LogQuery,
  LogRecord,
  RailwayTarget,
} from '../model.js';
import { floorMs, levelAllowed } from '../normalize.js';
import type { LogSource } from '../source.js';
import { makeRailwayClient } from './client.js';
import {
  grepFilter,
  httpStatusFilter,
  joinFilter,
  levelFilter,
} from './filters.js';
import {
  mapRailwayDeployment,
  mapRailwayHttpLog,
  mapRailwayLog,
  PROVIDER,
} from './normalize.js';
import { fetchLimitFor, pageRailway, type TimeCursor } from './paging.js';
import {
  BUILD_LOGS_QUERY,
  DEPLOYMENT_LOGS_QUERY,
  DEPLOYMENTS_QUERY,
  ENVIRONMENT_LOGS_QUERY,
  HTTP_LOGS_QUERY,
  PROJECT_QUERY,
} from './queries.js';
import {
  BuildLogsData,
  DeploymentLogsData,
  DeploymentsData,
  EnvironmentLogsData,
  HttpLogsData,
  ProjectData,
} from './schema.js';

export const RAILWAY_RETENTION_NOTE =
  'Railway keeps logs for 3 days (Free), 7 days (Hobby) or 30 days (Pro); older logs are gone, so an empty result past that window is not evidence of "no errors".';

export const makeRailwaySource = (target: RailwayTarget) =>
  Effect.gen(function* () {
    const client = yield* makeRailwayClient;
    const query = client.query;

    const ids = yield* Effect.cached(
      Effect.gen(function* () {
        const data = yield* query(
          'project',
          PROJECT_QUERY,
          { raw: { id: target.project } },
          ProjectData,
        );
        const project = data.project;
        if (project === null) {
          return yield* new ProviderNotFound({
            provider: PROVIDER,
            what: `project ${target.project}`,
            hint: 'check `project` in the config against `railway list --json`',
          });
        }
        const service = project.services.edges.find(
          (edge) => edge.node.name === target.serviceName,
        );
        if (service === undefined) {
          return yield* new ProviderNotFound({
            provider: PROVIDER,
            what: `service "${target.serviceName}" in project ${target.project}`,
            hint: `available services: ${project.services.edges.map((edge) => edge.node.name).join(', ')}`,
          });
        }
        const environment = project.environments.edges.find(
          (edge) => edge.node.name === target.environment,
        );
        if (environment === undefined) {
          return yield* new ProviderNotFound({
            provider: PROVIDER,
            what: `environment "${target.environment}" in project ${target.project}`,
            hint: `available environments: ${project.environments.edges.map((edge) => edge.node.name).join(', ')}`,
          });
        }
        return {
          serviceId: service.node.id,
          environmentId: environment.node.id,
        };
      }),
    );

    const deployments = (
      input: DeploymentQuery,
    ): Effect.Effect<DeploymentPage, ProviderError> =>
      Effect.gen(function* () {
        const resolved = yield* ids;
        const after =
          input.cursor?.kind === 'railway-relay'
            ? input.cursor.after
            : undefined;
        const data = yield* query(
          'deployments',
          DEPLOYMENTS_QUERY,
          {
            raw: {
              after,
              p: target.project,
              e: resolved.environmentId,
              s: resolved.serviceId,
            },
            json: { first: input.limit },
          },
          DeploymentsData,
        );
        const endCursor = data.deployments.pageInfo.endCursor;
        return {
          deployments: data.deployments.edges.map((edge) =>
            mapRailwayDeployment(edge.node, target),
          ),
          ...(data.deployments.pageInfo.hasNextPage &&
          endCursor !== null &&
          endCursor !== undefined
            ? { next: { kind: 'railway-relay' as const, after: endCursor } }
            : {}),
        };
      });

    const resolveDeploymentId = (requested: string | undefined) =>
      Effect.gen(function* () {
        if (requested !== undefined && requested !== 'latest') return requested;
        const page = yield* deployments({ limit: 10 });
        const latest = page.deployments.find(
          (deployment) => deployment.rawStatus !== 'SKIPPED',
        );
        if (latest === undefined) {
          return yield* new ProviderNotFound({
            provider: PROVIDER,
            what: `a deployment of ${target.service} in ${target.environment}`,
            hint: 'run `traces deploys` to see what exists',
          });
        }
        return latest.id;
      });

    const timeCursor = (input: LogQuery): TimeCursor | undefined =>
      input.cursor?.kind === 'railway-time' ? input.cursor : undefined;

    const windowStart = (input: LogQuery, cursor: TimeCursor | undefined) =>
      cursor === undefined ? input.since?.getTime() : cursor.since;

    const finish = (
      input: LogQuery,
      records: ReadonlyArray<LogRecord>,
      next: Cursor | undefined,
    ): LogPage => ({
      records: records.filter((record) => levelAllowed(input.levels, record)),
      ...(next === undefined ? {} : { next }),
    });

    const logs = (input: LogQuery): Effect.Effect<LogPage, ProviderError> =>
      Effect.gen(function* () {
        const cursor = timeCursor(input);
        const since = windowStart(input, cursor);
        const filter = joinFilter([
          levelFilter(input.levels),
          grepFilter(input.grep),
        ]);
        const fetchLimit = fetchLimitFor(input, cursor);
        if (input.deploymentId !== undefined) {
          const deploymentId = yield* resolveDeploymentId(input.deploymentId);
          const endDate =
            cursor !== undefined
              ? new Date(floorMs(cursor.before) + 1).toISOString()
              : input.until?.toISOString();
          const data = yield* query(
            'deploymentLogs',
            DEPLOYMENT_LOGS_QUERY,
            {
              raw: {
                d: deploymentId,
                f: filter,
                s:
                  since === undefined
                    ? undefined
                    : new Date(since).toISOString(),
                e: endDate,
              },
              json: { l: fetchLimit },
            },
            DeploymentLogsData,
          );
          const page = pageRailway({
            rows: data.deploymentLogs,
            timestamp: (row) => row.timestamp,
            key: (row) => row.message,
            limit: input.limit,
            since,
            cursor,
          });
          return finish(
            input,
            page.kept.map((row) =>
              mapRailwayLog(row, {
                target,
                source: 'runtime',
                deploymentId,
              }),
            ),
            page.next,
          );
        }
        const resolved = yield* ids;
        const anchor =
          cursor !== undefined
            ? cursor.before
            : (input.until ?? new Date()).toISOString();
        const data = yield* query(
          'environmentLogs',
          ENVIRONMENT_LOGS_QUERY,
          {
            raw: {
              e: resolved.environmentId,
              f: joinFilter([`@service:${resolved.serviceId}`, filter]),
              a: anchor,
              b:
                since === undefined ? undefined : new Date(since).toISOString(),
            },
            json: { l: fetchLimit },
          },
          EnvironmentLogsData,
        );
        const page = pageRailway({
          rows: data.environmentLogs,
          timestamp: (row) => row.timestamp,
          key: (row) => row.message,
          limit: input.limit,
          since,
          cursor,
        });
        return finish(
          input,
          page.kept.map((row) =>
            mapRailwayLog(row, { target, source: 'runtime' }),
          ),
          page.next,
        );
      });

    const buildLogs = (
      input: LogQuery,
    ): Effect.Effect<LogPage, ProviderError> =>
      Effect.gen(function* () {
        const cursor = timeCursor(input);
        const since = windowStart(input, cursor);
        const deploymentId = yield* resolveDeploymentId(input.deploymentId);
        const endDate =
          cursor !== undefined
            ? new Date(floorMs(cursor.before) + 1).toISOString()
            : input.until?.toISOString();
        const data = yield* query(
          'buildLogs',
          BUILD_LOGS_QUERY,
          {
            raw: {
              d: deploymentId,
              f: joinFilter([
                levelFilter(input.levels),
                grepFilter(input.grep),
              ]),
              s:
                since === undefined ? undefined : new Date(since).toISOString(),
              e: endDate,
            },
            json: { l: fetchLimitFor(input, cursor) },
          },
          BuildLogsData,
        );
        const page = pageRailway({
          rows: data.buildLogs,
          timestamp: (row) => row.timestamp,
          key: (row) => row.message,
          limit: input.limit,
          since,
          cursor,
        });
        return finish(
          input,
          page.kept.map((row) =>
            mapRailwayLog(row, { target, source: 'build', deploymentId }),
          ),
          page.next,
        );
      });

    const httpLogs = (input: LogQuery): Effect.Effect<LogPage, ProviderError> =>
      Effect.gen(function* () {
        const cursor = timeCursor(input);
        const since = windowStart(input, cursor);
        const deploymentId = yield* resolveDeploymentId(input.deploymentId);
        const anchor =
          cursor !== undefined
            ? cursor.before
            : (input.until ?? new Date()).toISOString();
        const data = yield* query(
          'httpLogs',
          HTTP_LOGS_QUERY,
          {
            raw: {
              d: deploymentId,
              f: joinFilter([
                httpStatusFilter(input.levels),
                grepFilter(input.grep),
              ]),
              a: anchor,
              b:
                since === undefined ? undefined : new Date(since).toISOString(),
            },
            json: { l: fetchLimitFor(input, cursor) },
          },
          HttpLogsData,
        );
        const page = pageRailway({
          rows: data.httpLogs,
          timestamp: (row) => row.timestamp,
          key: (row) => row.requestId,
          limit: input.limit,
          since,
          cursor,
        });
        return finish(
          input,
          page.kept.map((row) =>
            mapRailwayHttpLog(row, { target, deploymentId }),
          ),
          page.next,
        );
      });

    const source: LogSource = {
      provider: PROVIDER,
      retentionNote: RAILWAY_RETENTION_NOTE,
      logs,
      httpLogs,
      buildLogs,
      deployments,
    };
    return source;
  });
