import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import {
  type Deployment,
  type DeploymentPage,
  type DeploymentQuery,
  type LogSource,
  latestReadyDeployment,
} from '#/index.js';

const deployment = (
  id: string,
  createdAt: string,
  status: Deployment['status'],
): Deployment => ({
  id,
  service: 'api',
  provider: 'railway',
  environment: 'production',
  status,
  rawStatus: status.toUpperCase(),
  createdAt,
});

/** Serves `all` in `pageSize` chunks, in the given order, and records each query. */
const fakeSource = (
  all: ReadonlyArray<Deployment>,
  pageSize = 100,
  queries: Array<DeploymentQuery> = [],
): LogSource => {
  const unused = () => Effect.die('not used');
  return {
    provider: 'railway',
    retentionNote: '',
    logs: unused,
    httpLogs: unused,
    buildLogs: unused,
    resolveDeploymentId: unused,
    deployments: (query) => {
      queries.push(query);
      const offset =
        query.cursor?.kind === 'railway-relay' ? Number(query.cursor.after) : 0;
      const size = Math.min(query.limit, pageSize);
      const end = offset + size;
      return Effect.succeed({
        deployments: all.slice(offset, end),
        ...(end < all.length
          ? { next: { kind: 'railway-relay' as const, after: String(end) } }
          : {}),
      } satisfies DeploymentPage);
    },
  };
};

const run = (source: LogSource, scan = 20) =>
  Effect.runPromise(
    latestReadyDeployment(source, { service: 'api', scan }).pipe(Effect.result),
  );

describe('latestReadyDeployment', () => {
  test('picks the newest ready by createdAt, whatever order the provider returns', async () => {
    const result = await run(
      fakeSource([
        deployment('old', '2026-10-10T00:00:00.000Z', 'ready'),
        deployment('new', '2026-10-14T00:00:00.000Z', 'ready'),
        deployment('mid', '2026-10-12T00:00:00.000Z', 'ready'),
      ]),
    );
    expect(result._tag === 'Success' && result.success.id).toBe('new');
  });

  test('skips removed, failed and in-flight deployments even when newer', async () => {
    const result = await run(
      fakeSource([
        deployment('building', '2026-10-16T00:00:00.000Z', 'building'),
        deployment('failed', '2026-10-15T00:00:00.000Z', 'failed'),
        deployment('removed', '2026-10-14T00:00:00.000Z', 'removed'),
        deployment('live', '2026-10-13T00:00:00.000Z', 'ready'),
      ]),
    );
    expect(result._tag === 'Success' && result.success.id).toBe('live');
  });

  test('fails with NoReadyDeployment naming the service and how many were scanned', async () => {
    const result = await run(
      fakeSource([
        deployment('a', '2026-10-14T00:00:00.000Z', 'removed'),
        deployment('b', '2026-10-13T00:00:00.000Z', 'failed'),
      ]),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toMatchObject({
        _tag: 'NoReadyDeployment',
        service: 'api',
        scanned: 2,
      });
    }
  });

  test('pages until `scan` records and no further', async () => {
    const all = Array.from({ length: 30 }, (_, index) =>
      deployment(
        `d${index}`,
        new Date(Date.UTC(2026, 9, 1, 0, 30 - index)).toISOString(),
        index === 25 ? 'ready' : 'removed',
      ),
    );
    const queries: Array<DeploymentQuery> = [];
    const result = await run(fakeSource(all, 10, queries), 20);
    expect(queries.map((query) => query.limit)).toEqual([20, 10]);
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure).toMatchObject({ scanned: 20 });
    }
    const wider = await run(fakeSource(all, 10), 30);
    expect(wider._tag === 'Success' && wider.success.id).toBe('d25');
  });
});
