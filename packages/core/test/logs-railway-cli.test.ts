import { describe, expect, test } from 'bun:test';
import { Effect, Schema } from 'effect';
import {
  checkRailwayAccess,
  makeRailwayCliClient,
  makeRailwaySource,
  type RailwayTarget,
} from '#/index.js';
import {
  type FakeRailwayCliOptions,
  fakeRailwayCli,
  fixture,
  type RailwayCliCall,
} from './logs-helpers.ts';

const target: RailwayTarget = {
  provider: 'railway',
  service: 'api',
  project: 'proj-1',
  serviceName: 'api',
  environment: 'production',
};

const respond = (call: RailwayCliCall): unknown => {
  if (call.document.includes('project(id'))
    return fixture('railway-project.json');
  if (call.document.includes('environmentLogs')) return { environmentLogs: [] };
  throw new Error(`unexpected query: ${call.document}`);
};

const withCli = <A, E>(
  effect: (
    client: Effect.Success<typeof makeRailwayCliClient>,
  ) => Effect.Effect<A, E>,
  calls: Array<RailwayCliCall> = [],
  options: FakeRailwayCliOptions = {},
) =>
  Effect.runPromise(
    makeRailwayCliClient.pipe(
      Effect.flatMap(effect),
      Effect.provide(fakeRailwayCli(respond, calls, options)),
    ),
  );

describe('railway CLI client', () => {
  test('sends strings with --raw-var and numbers with --var, dropping undefined', async () => {
    const calls: Array<RailwayCliCall> = [];
    await withCli(
      (client) =>
        Effect.flatMap(makeRailwaySource(target, client), (source) =>
          source.logs({ levels: [], limit: 4 }),
        ),
      calls,
    );
    const query = calls.find((call) =>
      call.document.includes('environmentLogs'),
    );
    expect(query?.args.slice(0, 1)).toEqual(['api']);
    expect(query?.args).toContain('--compact');
    expect(query?.args).toContain('--raw-var');
    expect(query?.args).toContain('--var');
    expect(query?.args).toContain('l=4');
    const varFlagIndex = query?.args.indexOf('l=4') ?? -1;
    expect(query?.args[varFlagIndex - 1]).toBe('--var');
    const rawFlagIndex = query?.args.indexOf('e=env-prod') ?? -1;
    expect(query?.args[rawFlagIndex - 1]).toBe('--raw-var');
    expect(query?.variables).not.toHaveProperty('b');
  });

  test('checkRailwayAccess reads the project through the CLI', async () => {
    const calls: Array<RailwayCliCall> = [];
    await withCli((client) => checkRailwayAccess(client, 'proj-1'), calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables).toEqual({ id: 'proj-1' });
  });

  test('turns a "Not Authorized" GraphQL error into an auth error with the login hint', async () => {
    const failure = await withCli(
      (client) =>
        client
          .query('probe', '{ me { id } }', {}, Schema.Unknown)
          .pipe(Effect.flip),
      [],
      {
        stdout: JSON.stringify({
          data: null,
          errors: [{ message: 'Not Authorized' }],
        }),
      },
    );
    expect(failure).toMatchObject({
      _tag: 'ProviderAuthError',
      hint: 'run `railway login`',
    });
  });

  test('turns a not-logged-in stderr into an auth error', async () => {
    const failure = await withCli(
      (client) =>
        client
          .query('probe', '{ me { id } }', {}, Schema.Unknown)
          .pipe(Effect.flip),
      [],
      { exitCode: 1, stdout: '', stderr: 'Please login to continue' },
    );
    expect(failure).toMatchObject({ _tag: 'ProviderAuthError' });
  });

  test('a missing binary is an auth error with the install hint', async () => {
    const failure = await withCli(
      (client) =>
        client
          .query('probe', '{ me { id } }', {}, Schema.Unknown)
          .pipe(Effect.flip),
      [],
      { missingBinary: true },
    );
    expect(failure).toMatchObject({ _tag: 'ProviderAuthError' });
    expect(JSON.stringify(failure)).toContain('install the Railway CLI');
  });

  test('a non-zero exit with other errors is a request error', async () => {
    const failure = await withCli(
      (client) =>
        client
          .query('probe', '{ me { id } }', {}, Schema.Unknown)
          .pipe(Effect.flip),
      [],
      { exitCode: 1, stdout: '', stderr: 'boom' },
    );
    expect(failure).toMatchObject({ _tag: 'ProviderRequestError' });
    expect(String((failure as { cause: unknown }).cause)).toContain('boom');
  });

  test('output that is not an envelope is an invalid response', async () => {
    const failure = await withCli(
      (client) =>
        client
          .query('probe', '{ me { id } }', {}, Schema.Unknown)
          .pipe(Effect.flip),
      [],
      { stdout: 'hello' },
    );
    expect(failure).toMatchObject({ _tag: 'ProviderResponseInvalid' });
  });
});
