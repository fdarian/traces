import { describe, expect, test } from 'bun:test';
import { Effect, Redacted } from 'effect';
import {
  fetchVercelProjectName,
  railwayLinkedProject,
  railwayProjectLayout,
} from '#/index.js';
import { fakeHttp, fakeRailway, fixture } from './logs-helpers.ts';

const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(Effect.result(effect));

const nothing = () => {
  throw new Error('no GraphQL call expected');
};

describe('railwayLinkedProject', () => {
  test('reads the project id from `railway status --json` and ignores the rest', async () => {
    const result = await run(
      railwayLinkedProject('/repo').pipe(
        Effect.provide(
          fakeRailway(nothing, [], {
            stdout: JSON.stringify({
              id: 'proj-1',
              name: 'mockingbird',
              environments: { edges: [] },
            }),
          }),
        ),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Success',
      success: { id: 'proj-1' },
    });
  });

  test('a logged-out CLI is an auth error', async () => {
    const result = await run(
      railwayLinkedProject('/repo').pipe(
        Effect.provide(
          fakeRailway(nothing, [], {
            exitCode: 1,
            stdout: 'Unauthorized. Please login with `railway login`',
          }),
        ),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProviderAuthError' },
    });
  });

  test('an unlinked folder is a not-found with the link hint', async () => {
    const result = await run(
      railwayLinkedProject('/repo').pipe(
        Effect.provide(
          fakeRailway(nothing, [], {
            exitCode: 1,
            stdout:
              'No linked project found. Run railway link to connect to a project',
          }),
        ),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProviderNotFound' },
    });
  });

  test('output without an id is a response-shape error', async () => {
    const result = await run(
      railwayLinkedProject('/repo').pipe(
        Effect.provide(fakeRailway(nothing, [], { stdout: '{"name":"x"}' })),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProviderResponseInvalid' },
    });
  });
});

describe('railwayProjectLayout', () => {
  test('lists the services and environments of the project', async () => {
    const result = await run(
      railwayProjectLayout('proj-1').pipe(
        Effect.provide(fakeRailway(() => fixture('railway-project.json'))),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Success',
      success: {
        services: [
          { id: 'svc-api', name: 'api' },
          { id: 'svc-web', name: 'web' },
        ],
        environments: [
          { id: 'env-prod', name: 'production' },
          { id: 'env-stg', name: 'staging' },
        ],
      },
    });
  });

  test('a project Railway cannot see is a not-found', async () => {
    const result = await run(
      railwayProjectLayout('proj-1').pipe(
        Effect.provide(fakeRailway(() => ({ project: null }))),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProviderNotFound' },
    });
  });
});

describe('fetchVercelProjectName', () => {
  test('asks GET /v9/projects/{id} scoped to the team and returns the name', async () => {
    const calls: Array<{ url: string }> = [];
    const result = await run(
      fetchVercelProjectName(
        { id: 'prj_1', team: 'team_9' },
        Redacted.make('token'),
      ).pipe(
        Effect.provide(
          fakeHttp(() => ({ body: fixture('vercel-project.json') }), calls),
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: 'Success', success: 'app' });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v9/projects/prj_1');
    expect(url.searchParams.get('teamId')).toBe('team_9');
  });
});
