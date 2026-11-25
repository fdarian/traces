import { Effect, Option, type Redacted } from 'effect';
import { type ProviderError, ProviderNotFound } from '../errors.js';
import type {
  Cursor,
  DeploymentPage,
  DeploymentQuery,
  LogLevel,
  LogPage,
  LogQuery,
  LogRecord,
  VercelTarget,
} from '../model.js';
import { levelAllowed, matchesGrep, shortHash } from '../normalize.js';
import { type PageResume, pageBackwards, pageWidening } from '../paging.js';
import type { LogSource } from '../source.js';
import { makeVercelClient, VERCEL_API } from './client.js';
import {
  mapBuildEvent,
  mapHttpRow,
  mapRuntimeRow,
  mapVercelDeployment,
  PROVIDER,
} from './normalize.js';
import {
  type BuildEvent,
  BuildEventsResponse,
  DeploymentsResponse,
  ProjectResponse,
  type RequestLogRow,
  RequestLogsResponse,
} from './schema.js';

const REQUEST_LOGS = 'https://vercel.com/api/logs/request-logs';
const MAX_RUNTIME_PAGES = 50;
const MAX_BUILD_EVENTS = 5000;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export const VERCEL_RETENTION_NOTE =
  'Vercel keeps runtime logs for 1 hour (Hobby), 1 day (Pro) or 30 days (Observability Plus); build logs live as long as the deployment. An empty runtime result past that window is not evidence of "no errors".';

const encodeServerLevel = (levels: ReadonlyArray<LogLevel>) =>
  levels.length > 0 &&
  levels.every((level) => level === 'error' || level === 'fatal')
    ? 'error'
    : undefined;

const padMs = (ms: number) => String(ms).padStart(16, '0');

/**
 * Resume point for a capped fetch that kept fewer than a page of rows. It sits
 * on the oldest kept row; when nothing was kept, on the oldest timestamped raw
 * event, which has no delivered rows to remember.
 */
const resumeBelow = (
  kept: ReadonlyArray<{ readonly position: string; readonly key: string }>,
  raw: ReadonlyArray<{ readonly position: string }>,
): PageResume | undefined => {
  const oldest = kept[0];
  if (oldest !== undefined) {
    return {
      before: oldest.position,
      seen: kept
        .filter((row) => row.position === oldest.position)
        .map((row) => shortHash(row.key)),
    };
  }
  const oldestRaw = raw.reduce<string | undefined>(
    (min, event) =>
      min === undefined || event.position < min ? event.position : min,
    undefined,
  );
  return oldestRaw === undefined ? undefined : { before: oldestRaw, seen: [] };
};

const unwrapEnvironment = (target: VercelTarget) =>
  target.environment === 'production' ? 'production' : 'preview';

export const makeVercelSource = (
  target: VercelTarget,
  token: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const vercel = yield* makeVercelClient(target, token);
    const teamParams = vercel.teamParams;
    const get = vercel.get;

    const project = yield* Effect.cached(
      get(
        'project',
        `${VERCEL_API}/v9/projects/${encodeURIComponent(target.project)}`,
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
          `${VERCEL_API}/v6/deployments`,
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
        const fetchEvents = (limit: string) =>
          get(
            'build-events',
            `${VERCEL_API}/v3/deployments/${encodeURIComponent(deploymentId)}/events`,
            {
              ...teamParams,
              direction: 'backward',
              limit,
              // Widened by 1ms: whether the bound is inclusive is unverified.
              until: until === undefined ? undefined : String(until + 1),
            },
            BuildEventsResponse,
          );
        const sinceMs = input.since?.getTime();
        const pageOf = (events: ReadonlyArray<BuildEvent>) => {
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
          return pageBackwards({
            rows: entries,
            position: (entry) => padMs(entry.created),
            key: (entry) => entry.id ?? entry.record.message,
            limit: input.limit,
            resume:
              cursor === undefined
                ? undefined
                : { before: padMs(cursor.until), seen: cursor.seen },
          });
        };
        const fetched = filtered
          ? // Filters apply client-side, so a bounded fetch could hide matches.
            yield* fetchEvents('-1').pipe(
              Effect.map((rows) => ({
                rows,
                page: pageOf(rows),
                cutShort: false,
              })),
            )
          : yield* pageWidening({
              fetch: (fetchLimit) => fetchEvents(String(fetchLimit + 1)),
              page: pageOf,
              limit: input.limit,
              initialFetchLimit: input.limit + seen,
              maxFetchLimit: MAX_BUILD_EVENTS,
            });
        const page = fetched.page;
        // Events without text or timestamp are dropped, so only the raw count
        // says whether a fetch capped at `MAX_BUILD_EVENTS` left older events behind.
        const next =
          page.next === undefined && fetched.cutShort
            ? resumeBelow(
                page.kept.map((entry) => ({
                  position: padMs(entry.created),
                  key: entry.id ?? entry.record.message,
                })),
                fetched.rows.flatMap((event) =>
                  event.created === undefined
                    ? []
                    : [{ position: padMs(event.created) }],
                ),
              )
            : page.next;
        return {
          records: page.kept.map((entry) => entry.record),
          ...(next === undefined
            ? {}
            : {
                next: {
                  kind: 'vercel-until' as const,
                  until: Number(next.before),
                  seen: next.seen,
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
      resolveDeploymentId,
    };
    return source;
  });
