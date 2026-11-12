import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { Effect, Option } from 'effect';
import { decodeRepoConfig } from '#/config.ts';
import {
  assignServiceKeys,
  buildTracing,
  findVercelLinks,
  parseJaegerHeader,
  slugify,
} from '#/init.ts';

const vercel = (project: string) => ({
  provider: 'vercel' as const,
  project,
});
const railway = (service: string) => ({
  provider: 'railway' as const,
  project: 'proj-1',
  service,
});

describe('slugify', () => {
  test('keeps the identifier alphabet and collapses the rest', () => {
    expect(slugify('telegram-cron')).toBe('telegram-cron');
    expect(slugify('My App (prod)')).toBe('My-App-prod');
    expect(slugify('@scope/web')).toBe('scope-web');
    expect(slugify('日本')).toBe('');
  });
});

describe('assignServiceKeys', () => {
  test('a name used by both providers is suffixed with each provider', () => {
    const keys = assignServiceKeys([
      { name: 'web', config: railway('web') },
      { name: 'api', config: railway('api') },
      { name: 'web', config: vercel('prj_1') },
    ]);
    expect(Object.keys(keys)).toEqual(['web-railway', 'api', 'web-vercel']);
  });

  test('a collision inside one provider gets a number, and an unusable name falls back to the provider', () => {
    const keys = assignServiceKeys([
      { name: 'web', config: vercel('prj_1') },
      { name: 'web', config: vercel('prj_2') },
      { name: '日本', config: vercel('prj_3') },
    ]);
    expect(Object.keys(keys)).toEqual(['web', 'web-2', 'vercel']);
  });

  test('a suffixed key never overwrites an existing one', () => {
    const keys = assignServiceKeys([
      { name: 'web-vercel', config: railway('web-vercel') },
      { name: 'web', config: railway('web') },
      { name: 'web', config: vercel('prj_1') },
    ]);
    expect(Object.keys(keys).sort()).toEqual([
      'web-railway',
      'web-vercel',
      'web-vercel-2',
    ]);
  });
});

describe('jaeger flags', () => {
  const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
    Effect.runPromise(Effect.result(effect));

  test('a header is Name=keychain:secret', async () => {
    expect(
      await run(parseJaegerHeader('X-API-Key=keychain:app.jaeger')),
    ).toMatchObject({
      _tag: 'Success',
      success: ['X-API-Key', { keychain: 'app.jaeger' }],
    });
    for (const bad of [
      'X-API-Key',
      'X-API-Key=literal',
      '=keychain:x',
      'A=keychain:',
    ]) {
      expect((await run(parseJaegerHeader(bad)))._tag).toBe('Failure');
    }
  });

  test('headers need a url and each name appears once', async () => {
    expect(
      (await run(buildTracing(Option.none(), ['A=keychain:x'])))._tag,
    ).toBe('Failure');
    expect(
      (
        await run(
          buildTracing(Option.some('https://j.example.com'), [
            'A=keychain:x',
            'A=keychain:y',
          ]),
        )
      )._tag,
    ).toBe('Failure');
    const none = await run(buildTracing(Option.none(), []));
    expect(none._tag === 'Success' && Option.isNone(none.success)).toBe(true);
  });
});

let root: string;

const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

const link = (dir: string, extra: Record<string, string> = {}) =>
  write(
    join(dir, '.vercel', 'project.json'),
    JSON.stringify({
      projectId: `prj_${dir.length}`,
      orgId: 'team_1',
      ...extra,
    }),
  );

const newRepo = (name: string) => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: path }).exitCode).toBe(0);
  return path;
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'traces-init-')));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'home'));
  const script = join(root, 'bin', 'railway');
  writeFileSync(
    script,
    `#!/bin/sh
case "$1" in
  status)
    if [ "$FAKE_RAILWAY" = unlinked ]; then
      echo "No linked project found. Run railway link to connect to a project" >&2
      exit 1
    fi
    echo '{"id":"proj-1","name":"mockingbird","environments":{"edges":[]}}'
    ;;
  api)
    if [ "$FAKE_RAILWAY" = missing ]; then
      echo '{"data":{"project":null}}'
      exit 0
    fi
    echo '{"data":{"project":{"services":{"edges":[{"node":{"id":"s1","name":"engine"},"x":1},{"node":{"id":"s2","name":"web"}}]},"environments":{"edges":[{"node":{"id":"e1","name":"production"}},{"node":{"id":"e2","name":"staging"}}]}}}}'
    ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(script, 0o755);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findVercelLinks', () => {
  test('reads links up to three folders deep and skips node_modules and .git', async () => {
    const repo = newRepo('links');
    link(repo, { projectName: 'root-app' });
    link(join(repo, 'apps', 'web'));
    link(join(repo, 'a', 'b', 'c'));
    link(join(repo, 'a', 'b', 'c', 'd'));
    link(join(repo, 'node_modules', 'pkg'));
    write(
      join(repo, 'apps', 'bad', '.vercel', 'project.json'),
      '{"projectId":1}',
    );
    const links = await Effect.runPromise(
      findVercelLinks(repo).pipe(Effect.provide(BunServices.layer)),
    );
    expect(links.map((entry) => entry.fallbackName)).toEqual([
      'root-app',
      'c',
      'web',
    ]);
    expect(links.every((entry) => entry.orgId === 'team_1')).toBe(true);
  });

  test('a link file naming the same project twice is returned once', async () => {
    const repo = newRepo('dupes');
    for (const dir of ['one', 'two']) {
      write(
        join(repo, dir, '.vercel', 'project.json'),
        '{"projectId":"prj_same","orgId":"team_1"}',
      );
    }
    const links = await Effect.runPromise(
      findVercelLinks(repo).pipe(Effect.provide(BunServices.layer)),
    );
    expect(links).toHaveLength(1);
  });
});

const traces = (
  cwd: string,
  args: ReadonlyArray<string>,
  fakeRailway: 'linked' | 'unlinked' | 'missing' = 'linked',
) => {
  const run = Bun.spawnSync(
    ['bun', join(import.meta.dir, '..', 'src', 'main.ts'), 'init', ...args],
    {
      cwd,
      env: {
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        HOME: join(root, 'home'),
        XDG_DATA_HOME: join(root, 'home', 'data'),
        FAKE_RAILWAY: fakeRailway,
      },
    },
  );
  return {
    code: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
};

const decode = (json: string) =>
  Effect.runPromise(
    decodeRepoConfig('traces.json', json).pipe(
      Effect.provide(BunServices.layer),
    ),
  );

describe('traces init', () => {
  test('--dry-run prints a config that decodes and writes nothing', async () => {
    const repo = newRepo('dry');
    link(join(repo, 'apps', 'web'), { projectName: 'web' });
    const run = traces(repo, ['--dry-run']);
    expect(run.code).toBe(0);
    expect(existsSync(join(repo, 'traces.json'))).toBe(false);
    const config = await decode(run.stdout);
    expect(config.services).toEqual({
      engine: {
        provider: 'railway',
        project: 'proj-1',
        service: 'engine',
        environment: 'production',
      },
      'web-railway': {
        provider: 'railway',
        project: 'proj-1',
        service: 'web',
        environment: 'production',
      },
      'web-vercel': {
        provider: 'vercel',
        project: expect.stringMatching(/^prj_/),
        team: 'team_1',
      },
    });
    expect(config.tracing).toBeUndefined();
    expect(run.stderr).toContain('no token found');
  });

  test('writes traces.json, then refuses until --force', async () => {
    const repo = newRepo('write');
    const first = traces(repo, []);
    expect(first.code).toBe(0);
    const path = join(repo, 'traces.json');
    expect(first.stderr).toContain(`wrote ${path}`);
    expect(first.stderr).toContain('traces services');
    expect(first.stderr).toContain('commit traces.json');
    expect(first.stdout).toContain('engine');
    const written = readFileSync(path, 'utf8');
    expect(Object.keys((await decode(written)).services)).toEqual([
      'engine',
      'web',
    ]);

    writeFileSync(path, '{"services":{"keep":{"otelService":"keep"}}}');
    const second = traces(repo, []);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain('already exists');
    expect(readFileSync(path, 'utf8')).toContain('keep');

    expect(traces(repo, ['--force']).code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(written);
  });

  test('--jaeger-url and --jaeger-header add a tracing block and name the secrets to set', async () => {
    const repo = newRepo('tracing');
    const run = traces(repo, [
      '--jaeger-url',
      'https://jaeger.example.com',
      '--jaeger-header',
      'X-API-Key=keychain:app.jaeger',
    ]);
    expect(run.code).toBe(0);
    const config = await decode(
      readFileSync(join(repo, 'traces.json'), 'utf8'),
    );
    expect(config.tracing).toEqual({
      provider: 'jaeger',
      url: 'https://jaeger.example.com',
      headers: { 'X-API-Key': { keychain: 'app.jaeger' } },
    });
    expect(run.stderr).toContain('traces secret set app.jaeger');
  });

  test('a bad flag value exits 2 and writes nothing', () => {
    const repo = newRepo('bad-flags');
    for (const args of [
      ['--jaeger-url', 'not a url'],
      ['--jaeger-url', 'https://j.example.com', '--jaeger-header', 'oops'],
      ['--jaeger-header', 'A=keychain:x'],
    ]) {
      expect(traces(repo, args).code).toBe(2);
    }
    expect(existsSync(join(repo, 'traces.json'))).toBe(false);
  });

  test('outside a git repository it exits 2', () => {
    const folder = join(root, 'not-a-repo');
    mkdirSync(folder);
    const run = traces(folder, []);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('not inside a git repository');
  });

  test('an unlinked Railway folder is a note, and Vercel links alone still work', async () => {
    const repo = newRepo('vercel-only');
    link(repo, { projectName: 'site' });
    const run = traces(repo, ['--dry-run'], 'unlinked');
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('railway: skipped');
    expect(Object.keys((await decode(run.stdout)).services)).toEqual(['site']);
  });

  test('nothing discovered exits 1 with the link hint', () => {
    const repo = newRepo('empty');
    const run = traces(repo, ['--dry-run'], 'unlinked');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('hint: link the folder with `railway link`');
  });

  test('an explicit --railway-project that Railway cannot find is an error', () => {
    const repo = newRepo('explicit');
    link(repo);
    const run = traces(repo, ['--railway-project', 'gone'], 'missing');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('project gone');
  });
});
