import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { Effect, Option } from 'effect';
import { decodeRepoConfig } from '#/config.ts';
import { findRepoConfig } from '#/repo-config.ts';

const services = { web: { otelService: 'repo-web' } };

let root: string;

const write = (path: string, value: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

const initRepo = (path: string) => {
  mkdirSync(path, { recursive: true });
  const init = Bun.spawnSync(['git', 'init', '-q'], { cwd: path });
  expect(init.exitCode).toBe(0);
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'traces-repo-config-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const find = (cwd: string) =>
  Effect.runPromise(
    findRepoConfig(cwd).pipe(Effect.provide(BunServices.layer)),
  );

describe('repo config schema', () => {
  const decode = (value: unknown) =>
    Effect.runPromise(
      decodeRepoConfig('/repo/traces.json', JSON.stringify(value)).pipe(
        Effect.result,
      ),
    );

  test('name and $schema are optional', async () => {
    expect((await decode({ services }))._tag).toBe('Success');
    expect(
      (
        await decode({
          $schema: 'https://example.com/s.json',
          name: 'acme',
          services,
        })
      )._tag,
    ).toBe('Success');
  });

  test('unknown keys are an error, including a matcher', async () => {
    const result = await decode({
      services,
      matcher: { type: 'git', repo: 'a/b' },
    });
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure.message).toContain('matcher');
  });

  test('the error names the repo file path', async () => {
    const result = await decode({ services: {} });
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure.path).toBe('/repo/traces.json');
  });
});

describe('findRepoConfig', () => {
  test('finds the file in cwd and defaults the name to the toplevel basename', async () => {
    const repo = join(root, 'plain-repo');
    initRepo(repo);
    write(join(repo, 'traces.json'), { services });
    const found = Option.getOrThrow(await find(repo));
    expect(found.path).toBe(join(repo, 'traces.json'));
    expect(found.name).toBe('plain-repo');
    expect(found.project.services).toEqual(services);
  });

  test('carries railway.auth to the project', async () => {
    const repo = join(root, 'railway-repo');
    initRepo(repo);
    write(join(repo, 'traces.json'), {
      railway: { auth: { keychain: 'app.railway' } },
      services,
    });
    const found = Option.getOrThrow(await find(repo));
    expect(found.project.railway).toEqual({
      auth: { keychain: 'app.railway' },
    });
  });

  test('walks up from a subdirectory, and an explicit name wins', async () => {
    const repo = join(root, 'walk-repo');
    initRepo(repo);
    write(join(repo, 'traces.json'), { name: 'acme', services });
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
    const found = Option.getOrThrow(await find(join(repo, 'apps', 'web')));
    expect(found.path).toBe(join(repo, 'traces.json'));
    expect(found.name).toBe('acme');
  });

  test('the nearest file wins over one at the git root', async () => {
    const repo = join(root, 'nested-repo');
    initRepo(repo);
    write(join(repo, 'traces.json'), { name: 'outer', services });
    write(join(repo, 'apps', 'web', 'traces.json'), {
      name: 'inner',
      services,
    });
    const found = Option.getOrThrow(await find(join(repo, 'apps', 'web')));
    expect(found.name).toBe('inner');
  });

  test('the walk stops at the git root', async () => {
    write(join(root, 'above', 'traces.json'), { services });
    const repo = join(root, 'above', 'repo');
    initRepo(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    expect(Option.isNone(await find(join(repo, 'src')))).toBe(true);
  });

  test('outside a git repo only cwd is checked', async () => {
    write(join(root, 'bare', 'traces.json'), { services });
    mkdirSync(join(root, 'bare', 'sub'), { recursive: true });
    expect(Option.isNone(await find(join(root, 'bare', 'sub')))).toBe(true);
    const found = Option.getOrThrow(await find(join(root, 'bare')));
    expect(found.name).toBe('bare');
  });

  test('a malformed file is a ConfigError naming its path', async () => {
    const repo = join(root, 'broken-repo');
    initRepo(repo);
    writeFileSync(join(repo, 'traces.json'), '{nope');
    const result = await Effect.runPromise(
      findRepoConfig(repo).pipe(
        Effect.provide(BunServices.layer),
        Effect.result,
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure' && result.failure._tag === 'ConfigError')
      expect(result.failure.path).toBe(join(repo, 'traces.json'));
  });
});

describe('config lookup precedence', () => {
  const main = join(import.meta.dir, '..', 'src', 'main.ts');
  let xdg: string;
  let repo: string;

  beforeAll(() => {
    xdg = join(root, 'xdg');
    write(join(xdg, 'traces', 'config.json'), {
      projects: {
        acme: {
          matcher: { type: 'path', path: '/nonexistent-traces-test' },
          services: { web: { otelService: 'global-web' } },
        },
      },
    });
    repo = join(root, 'precedence-repo');
    initRepo(repo);
    write(join(repo, 'traces.json'), {
      name: 'acme',
      services: { web: { otelService: 'repo-web' } },
    });
    mkdirSync(join(repo, 'apps'), { recursive: true });
  });

  const runServices = async (cwd: string, args: ReadonlyArray<string> = []) => {
    const child = Bun.spawn(['bun', main, 'services', '--json', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
    });
    const [stdout, stderr, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    const document = code === 0 ? (JSON.parse(stdout) as unknown) : undefined;
    return { document, stderr, code };
  };

  test('the repo file is used from a subdirectory and reported as repo', async () => {
    const result = await runServices(join(repo, 'apps'));
    expect(result.code).toBe(0);
    expect(result.document).toMatchObject({
      configSource: 'repo',
      matchedBy: 'repo',
      project: 'acme',
      configPath: join(repo, 'traces.json'),
      services: [{ service: 'web', otelService: 'repo-web' }],
    });
  });

  test('--project skips the repo file for the global config', async () => {
    const result = await runServices(repo, ['--project', 'acme']);
    expect(result.document).toMatchObject({
      configSource: 'global',
      matchedBy: 'flag',
      services: [{ service: 'web', otelService: 'global-web' }],
    });
  });

  test('--config beats the repo file', async () => {
    const result = await runServices(repo, [
      '--config',
      join(xdg, 'traces', 'config.json'),
      '--project',
      'acme',
    ]);
    expect(result.document).toMatchObject({
      configSource: 'flag',
      services: [{ service: 'web', otelService: 'global-web' }],
    });
  });

  test('without a repo file the global config is used', async () => {
    const elsewhere = join(root, 'no-file-repo');
    initRepo(elsewhere);
    const result = await runServices(elsewhere);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(join(xdg, 'traces', 'config.json'));
  });

  test('a repo file decode error names the repo file path', async () => {
    const bad = join(root, 'bad-precedence-repo');
    initRepo(bad);
    write(join(bad, 'traces.json'), { services: {}, extra: 1 });
    const result = await runServices(bad);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(join(bad, 'traces.json'));
  });
});
