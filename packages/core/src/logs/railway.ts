import { Command, CommandExecutor } from '@effect/platform';
import type { PlatformError } from '@effect/platform/Error';
import { Effect, Option, Schema, Stream } from 'effect';
import {
  ProviderAuthError,
  type ProviderError,
  ProviderNotFound,
  ProviderRequestError,
  ProviderResponseInvalid,
} from './errors.js';
import type {
  Cursor,
  Deployment,
  DeploymentPage,
  DeploymentQuery,
  DeploymentStatus,
  LogLevel,
  LogPage,
  LogQuery,
  LogRecord,
  LogSourceKind,
  RailwayTarget,
} from './model.js';
import {
  decodeJsonAttribute,
  floorMs,
  levelAllowed,
  normalizeLevel,
  sortableIso,
  stripAnsi,
} from './normalize.js';
import { pageBackwards } from './paging.js';
import type { LogSource } from './source.js';

const PROVIDER = 'railway' as const;
const MAX_RAILWAY_LIMIT = 5000;
const INSTALL_HINT =
  'install the Railway CLI (https://docs.railway.com/guides/cli) and run `railway login`';
const LOGIN_HINT = 'run `railway login`';

export const RAILWAY_RETENTION_NOTE =
  'Railway keeps logs for 3 days (Free), 7 days (Hobby) or 30 days (Pro); older logs are gone, so an empty result past that window is not evidence of "no errors".';

const Envelope = Schema.parseJson(
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(Schema.Unknown)),
    errors: Schema.optional(
      Schema.Array(Schema.Struct({ message: Schema.String })),
    ),
  }),
);

const IsoTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
);

const RailwayLogRow = Schema.Struct({
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
type RailwayLogRow = typeof RailwayLogRow.Type;

const RailwayHttpRow = Schema.Struct({
  timestamp: IsoTimestamp,
  method: Schema.String,
  path: Schema.String,
  httpStatus: Schema.Number,
  totalDuration: Schema.Number,
  requestId: Schema.String,
  host: Schema.String,
});
type RailwayHttpRow = typeof RailwayHttpRow.Type;

const Named = Schema.Struct({ id: Schema.String, name: Schema.String });

const ProjectData = Schema.Struct({
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

const DeploymentNode = Schema.Struct({
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

const DeploymentsData = Schema.Struct({
  deployments: Schema.Struct({
    edges: Schema.Array(Schema.Struct({ node: DeploymentNode })),
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
});

const EnvironmentLogsData = Schema.Struct({
  environmentLogs: Schema.Array(RailwayLogRow),
});
const DeploymentLogsData = Schema.Struct({
  deploymentLogs: Schema.Array(RailwayLogRow),
});
const BuildLogsData = Schema.Struct({ buildLogs: Schema.Array(RailwayLogRow) });
const HttpLogsData = Schema.Struct({ httpLogs: Schema.Array(RailwayHttpRow) });

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

type TimeCursor = Extract<Cursor, { kind: 'railway-time' }>;

const pageRailway = <A>(input: {
  readonly rows: ReadonlyArray<A>;
  readonly timestamp: (row: A) => string;
  readonly key: (row: A) => string;
  readonly limit: number;
  readonly since?: number;
  readonly cursor?: TimeCursor;
}): { readonly kept: ReadonlyArray<A>; readonly next?: TimeCursor } => {
  const page = pageBackwards({
    rows: input.rows,
    position: (row) => sortableIso(input.timestamp(row)),
    key: input.key,
    limit: input.limit,
    resume: input.cursor,
  });
  if (page.next === undefined) return { kept: page.kept };
  return {
    kept: page.kept,
    next: {
      kind: 'railway-time',
      ...(input.since === undefined ? {} : { since: input.since }),
      before: page.next.before,
      seen: page.next.seen,
    },
  };
};

const levelFilter = (levels: ReadonlyArray<LogLevel>): string | undefined => {
  const native = new Set<string>();
  for (const level of levels) {
    if (level === 'fatal') native.add('error');
    else if (level !== 'unknown') native.add(level);
  }
  if (native.size === 0) return undefined;
  const terms = [...native].map((level) => `@level:${level}`);
  return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
};

const grepFilter = (grep: string | undefined): string | undefined =>
  grep === undefined
    ? undefined
    : `"${grep.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

const joinFilter = (
  parts: ReadonlyArray<string | undefined>,
): string | undefined => {
  const present = parts.filter((part) => part !== undefined);
  return present.length === 0 ? undefined : present.join(' ');
};

const httpStatusFilter = (levels: ReadonlyArray<LogLevel>) => {
  if (levels.length === 0 || levels.includes('info')) return undefined;
  return levels.includes('warn') ? '@httpStatus:>=400' : '@httpStatus:>=500';
};

const fetchLimitFor = (input: LogQuery, cursor: TimeCursor | undefined) =>
  Math.min(
    input.limit + (cursor === undefined ? 0 : cursor.seen.length),
    MAX_RAILWAY_LIMIT,
  );

interface Variables {
  readonly raw?: Readonly<Record<string, string | undefined>>;
  readonly json?: Readonly<Record<string, number | undefined>>;
}

const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

const looksUnauthorized = (text: string): boolean =>
  /not authorized|unauthorized|not logged in|please login|run `?railway login/i.test(
    text,
  );

export const makeRailwaySource = (target: RailwayTarget) =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;

    const runCli = (args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(
            Command.make('railway', ...args),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collect(process.stdout),
              collect(process.stderr),
              process.exitCode,
            ],
            { concurrency: 'unbounded' },
          );
          return { stdout, stderr, exitCode };
        }),
      ).pipe(
        Effect.mapError(
          (error): ProviderError =>
            error._tag === 'SystemError' && error.reason === 'NotFound'
              ? new ProviderAuthError({
                  provider: PROVIDER,
                  hint: INSTALL_HINT,
                })
              : new ProviderRequestError({ provider: PROVIDER, cause: error }),
        ),
      );

    const query = <A, I>(
      operation: string,
      document: string,
      variables: Variables,
      schema: Schema.Schema<A, I>,
    ): Effect.Effect<A, ProviderError> =>
      Effect.gen(function* () {
        const args = ['api', document, '--compact'];
        for (const [name, value] of Object.entries(variables.raw ?? {})) {
          if (value !== undefined) args.push('--raw-var', `${name}=${value}`);
        }
        for (const [name, value] of Object.entries(variables.json ?? {})) {
          if (value !== undefined) args.push('--var', `${name}=${value}`);
        }
        const result = yield* runCli(args);
        const envelope = Schema.decodeUnknownOption(Envelope)(result.stdout);
        const messages = Option.isSome(envelope)
          ? (envelope.value.errors ?? []).map((error) => error.message)
          : [];
        const detail =
          messages.length > 0
            ? messages.join('; ')
            : result.stderr.trim() || result.stdout.trim();
        if (looksUnauthorized(`${messages.join(' ')} ${result.stderr}`)) {
          return yield* new ProviderAuthError({
            provider: PROVIDER,
            hint: LOGIN_HINT,
          });
        }
        if (result.exitCode !== 0 || messages.length > 0) {
          return yield* new ProviderRequestError({
            provider: PROVIDER,
            cause: new Error(`railway api failed: ${detail}`),
          });
        }
        if (Option.isNone(envelope)) {
          return yield* new ProviderResponseInvalid({
            provider: PROVIDER,
            operation,
            cause: new Error(
              `not a JSON envelope: ${result.stdout.slice(0, 200)}`,
            ),
          });
        }
        return yield* Schema.decodeUnknown(schema)(envelope.value.data).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderResponseInvalid({
                provider: PROVIDER,
                operation,
                cause,
              }),
          ),
        );
      });

    const ids = yield* Effect.cached(
      Effect.gen(function* () {
        const data = yield* query(
          'project',
          'query($id:String!){project(id:$id){services{edges{node{id name}}} environments{edges{node{id name}}}}}',
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

    const toDeployment = (node: typeof DeploymentNode.Type): Deployment => {
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
                ...(message === null || message === undefined
                  ? {}
                  : { message }),
                ...(branch === null || branch === undefined ? {} : { branch }),
              },
            }),
      };
    };

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
          'query($first:Int,$after:String,$p:String!,$e:String!,$s:String!){deployments(first:$first,after:$after,input:{projectId:$p,environmentId:$e,serviceId:$s}){edges{node{id status createdAt staticUrl meta}} pageInfo{hasNextPage endCursor}}}',
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
            toDeployment(edge.node),
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
            'query($d:String!,$l:Int,$f:String,$s:DateTime,$e:DateTime){deploymentLogs(deploymentId:$d,limit:$l,filter:$f,startDate:$s,endDate:$e){timestamp message severity attributes{key value}}}',
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
          'query($e:String!,$f:String,$a:String,$b:String,$l:Int){environmentLogs(environmentId:$e,filter:$f,anchorDate:$a,beforeDate:$b,beforeLimit:$l,afterLimit:0){timestamp message severity attributes{key value} tags{deploymentId}}}',
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
          'query($d:String!,$l:Int,$f:String,$s:DateTime,$e:DateTime){buildLogs(deploymentId:$d,limit:$l,filter:$f,startDate:$s,endDate:$e){timestamp message severity attributes{key value}}}',
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
          'query($d:String!,$f:String,$a:String,$b:String,$l:Int){httpLogs(deploymentId:$d,filter:$f,anchorDate:$a,beforeDate:$b,beforeLimit:$l,afterLimit:0){timestamp method path httpStatus totalDuration requestId host}}',
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
