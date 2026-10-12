import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from '@effect/platform';
import { Effect, Option, Redacted, Schema } from 'effect';
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
  VercelTarget,
} from './model.js';
import {
  levelAllowed,
  matchesGrep,
  normalizeLevel,
  stripAnsi,
} from './normalize.js';
import { pageBackwards } from './paging.js';
import type { LogSource } from './source.js';

const PROVIDER = 'vercel' as const;
const API = 'https://api.vercel.com';
const REQUEST_LOGS = 'https://vercel.com/api/logs/request-logs';
const LOGIN_HINT = 'run `vercel login` or set VERCEL_TOKEN';
const MAX_RUNTIME_PAGES = 50;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export const VERCEL_RETENTION_NOTE =
  'Vercel keeps runtime logs for 1 hour (Hobby), 1 day (Pro) or 30 days (Observability Plus); build logs live as long as the deployment. An empty runtime result past that window is not evidence of "no errors".';

const ProjectResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  accountId: Schema.String,
});

const RequestLogLine = Schema.Struct({
  level: Schema.String,
  message: Schema.String,
});

const RequestLogRow = Schema.Struct({
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
type RequestLogRow = typeof RequestLogRow.Type;

const RequestLogsResponse = Schema.Struct({
  rows: Schema.Array(RequestLogRow),
  hasMoreRows: Schema.Boolean,
});

const DeploymentsResponse = Schema.Struct({
  deployments: Schema.Array(
    Schema.Struct({
      uid: Schema.String,
      readyState: Schema.String,
      target: Schema.optional(Schema.NullOr(Schema.String)),
      created: Schema.Number,
      url: Schema.optional(Schema.NullOr(Schema.String)),
      meta: Schema.optional(
        Schema.NullOr(
          Schema.Record({ key: Schema.String, value: Schema.Unknown }),
        ),
      ),
    }),
  ),
  pagination: Schema.Struct({
    next: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});
type VercelDeployment =
  (typeof DeploymentsResponse.Type)['deployments'][number];

const BuildEvent = Schema.Struct({
  id: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Number),
  type: Schema.String,
  text: Schema.optional(Schema.String),
  payload: Schema.optional(
    Schema.NullOr(Schema.Struct({ text: Schema.optional(Schema.String) })),
  ),
});
type BuildEvent = typeof BuildEvent.Type;
const BuildEventsResponse = Schema.Array(BuildEvent);

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

const encodeServerLevel = (levels: ReadonlyArray<LogLevel>) =>
  levels.length > 0 &&
  levels.every((level) => level === 'error' || level === 'fatal')
    ? 'error'
    : undefined;

const padMs = (ms: number) => String(ms).padStart(16, '0');

const unwrapEnvironment = (target: VercelTarget) =>
  target.environment === 'production' ? 'production' : 'preview';

export const makeVercelSource = (
  target: VercelTarget,
  token: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const teamParams: Record<string, string> =
      target.team === undefined
        ? {}
        : target.team.startsWith('team_')
          ? { teamId: target.team }
          : { slug: target.team };

    const get = <A, I>(
      operation: string,
      url: string,
      params: Readonly<Record<string, string | undefined>>,
      schema: Schema.Schema<A, I>,
    ): Effect.Effect<A, ProviderError> =>
      Effect.gen(function* () {
        const definedParams: Record<string, string> = {};
        for (const [name, value] of Object.entries(params)) {
          if (value !== undefined) definedParams[name] = value;
        }
        const request = HttpClientRequest.get(url).pipe(
          HttpClientRequest.setUrlParams(definedParams),
          HttpClientRequest.bearerToken(Redacted.value(token)),
        );
        const response: HttpClientResponse.HttpClientResponse = yield* client
          .execute(request)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRequestError({ provider: PROVIDER, cause }),
            ),
          );
        if (response.status === 401 || response.status === 403) {
          return yield* new ProviderAuthError({
            provider: PROVIDER,
            hint: `${LOGIN_HINT}; token lacks access to this ${target.team === undefined ? 'account' : `team "${target.team}"`}`,
          });
        }
        if (response.status === 404) {
          return yield* new ProviderNotFound({
            provider: PROVIDER,
            what: `${operation} (${url})`,
            hint: 'check `project` / `team` in the config',
          });
        }
        if (response.status >= 400) {
          const body = yield* response.text.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRequestError({ provider: PROVIDER, cause }),
            ),
          );
          return yield* new ProviderRequestError({
            provider: PROVIDER,
            cause: new Error(
              `${operation}: HTTP ${response.status}: ${body.slice(0, 300)}`,
            ),
          });
        }
        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) => new ProviderRequestError({ provider: PROVIDER, cause }),
          ),
        );
        return yield* Schema.decodeUnknown(schema)(json).pipe(
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

    const project = yield* Effect.cached(
      get(
        'project',
        `${API}/v9/projects/${encodeURIComponent(target.project)}`,
        teamParams,
        ProjectResponse,
      ),
    );

    const deployments = (
      input: DeploymentQuery,
    ): Effect.Effect<DeploymentPage, ProviderError> =>
      Effect.gen(function* () {
        const resolved = yield* project;
        const until =
          input.cursor?.kind === 'vercel-until'
            ? input.cursor.until
            : undefined;
        const data = yield* get(
          'deployments',
          `${API}/v6/deployments`,
          {
            ...teamParams,
            projectId: resolved.id,
            target: unwrapEnvironment(target),
            limit: String(input.limit),
            until: until === undefined ? undefined : String(until),
          },
          DeploymentsResponse,
        );
        const next = data.pagination.next;
        return {
          deployments: data.deployments.map((deployment) =>
            mapVercelDeployment(deployment, target),
          ),
          ...(next === null || next === undefined
            ? {}
            : {
                next: { kind: 'vercel-until' as const, until: next, seen: [] },
              }),
        };
      });

    const resolveDeploymentId = (requested: string | undefined) =>
      Effect.gen(function* () {
        if (requested !== undefined && requested !== 'latest') return requested;
        const page = yield* deployments({ limit: 1 });
        const latest = page.deployments[0];
        if (latest === undefined) {
          return yield* new ProviderNotFound({
            provider: PROVIDER,
            what: `a ${unwrapEnvironment(target)} deployment of ${target.project}`,
            hint: 'run `traces deploys` to see what exists',
          });
        }
        return latest.id;
      });

    const pagedRequests = (
      input: LogQuery,
      mapRow: (
        row: RequestLogRow,
        target: VercelTarget,
      ) => ReadonlyArray<LogRecord>,
    ): Effect.Effect<LogPage, ProviderError> =>
      Effect.gen(function* () {
        const resolved = yield* project;
        const deploymentId =
          input.deploymentId === undefined
            ? undefined
            : yield* resolveDeploymentId(input.deploymentId);
        const cursor =
          input.cursor?.kind === 'vercel-page' ? input.cursor : undefined;
        const until =
          cursor !== undefined
            ? cursor.until
            : (input.until ?? new Date()).getTime();
        const since =
          cursor !== undefined
            ? cursor.since
            : (input.since?.getTime() ?? until - DEFAULT_WINDOW_MS);
        let page = cursor === undefined ? 0 : cursor.page;
        let skip = cursor === undefined ? 0 : cursor.skip;
        const collected: Array<LogRecord> = [];
        let next: Cursor | undefined;
        for (let fetched = 0; ; fetched++) {
          if (fetched === MAX_RUNTIME_PAGES) {
            next = { kind: 'vercel-page', since, until, page, skip };
            break;
          }
          const data = yield* get(
            'request-logs',
            REQUEST_LOGS,
            {
              projectId: resolved.id,
              ownerId: resolved.accountId,
              page: String(page),
              startDate: String(since),
              endDate: String(until),
              environment: unwrapEnvironment(target),
              deploymentId,
              level: encodeServerLevel(input.levels),
              search: input.grep,
            },
            RequestLogsResponse,
          );
          const available = data.rows
            .flatMap((row) => mapRow(row, target))
            .filter(
              (record) =>
                levelAllowed(input.levels, record) &&
                matchesGrep(input.grep, record),
            )
            .slice(skip);
          const room = input.limit - collected.length;
          collected.push(...available.slice(0, room));
          if (available.length > room) {
            next = {
              kind: 'vercel-page',
              since,
              until,
              page,
              skip: skip + room,
            };
            break;
          }
          if (!data.hasMoreRows) break;
          page += 1;
          skip = 0;
          if (collected.length >= input.limit) {
            next = { kind: 'vercel-page', since, until, page, skip: 0 };
            break;
          }
        }
        return {
          records: collected.reverse(),
          ...(next === undefined ? {} : { next }),
        };
      });

    const logs = (input: LogQuery) => pagedRequests(input, mapRuntimeRow);
    const httpLogs = (input: LogQuery) => pagedRequests(input, mapHttpRow);

    const buildLogs = (
      input: LogQuery,
    ): Effect.Effect<LogPage, ProviderError> =>
      Effect.gen(function* () {
        const deploymentId = yield* resolveDeploymentId(input.deploymentId);
        const cursor =
          input.cursor?.kind === 'vercel-until' ? input.cursor : undefined;
        const until =
          cursor !== undefined ? cursor.until : input.until?.getTime();
        const seen = cursor === undefined ? 0 : cursor.seen.length;
        const filtered = input.levels.length > 0 || input.grep !== undefined;
        const events = yield* get(
          'build-events',
          `${API}/v3/deployments/${encodeURIComponent(deploymentId)}/events`,
          {
            ...teamParams,
            direction: 'backward',
            // Filters apply client-side, so a bounded fetch could hide matches.
            limit: filtered ? '-1' : String(input.limit + 1 + seen),
            // Widened by 1ms: whether the bound is inclusive is unverified.
            until: until === undefined ? undefined : String(until + 1),
          },
          BuildEventsResponse,
        );
        const sinceMs = input.since?.getTime();
        const entries = events.flatMap((event) => {
          const record = mapBuildEvent(event, { target, deploymentId });
          if (Option.isNone(record) || event.created === undefined) return [];
          if (sinceMs !== undefined && event.created < sinceMs) return [];
          if (!levelAllowed(input.levels, record.value)) return [];
          if (!matchesGrep(input.grep, record.value)) return [];
          return [
            { record: record.value, created: event.created, id: event.id },
          ];
        });
        const page = pageBackwards({
          rows: entries,
          position: (entry) => padMs(entry.created),
          key: (entry) => entry.id ?? entry.record.message,
          limit: input.limit,
          resume:
            cursor === undefined
              ? undefined
              : { before: padMs(cursor.until), seen: cursor.seen },
        });
        return {
          records: page.kept.map((entry) => entry.record),
          ...(page.next === undefined
            ? {}
            : {
                next: {
                  kind: 'vercel-until' as const,
                  until: Number(page.next.before),
                  seen: page.next.seen,
                },
              }),
        };
      });

    const source: LogSource = {
      provider: PROVIDER,
      retentionNote: VERCEL_RETENTION_NOTE,
      logs,
      httpLogs,
      buildLogs,
      deployments,
    };
    return source;
  });
