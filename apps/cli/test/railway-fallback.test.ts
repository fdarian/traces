import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_RAILWAY = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const document = args[1];
const reply = (data) => console.log(JSON.stringify({ data }));
if (process.env.FAKE_RAILWAY_DOWN === '1') {
  console.error('Unauthorized. Please login');
  process.exit(1);
}
if (document.includes('project(')) {
  reply({ project: {
    services: { edges: [
      { node: { id: 'svc-api', name: 'api' } },
      { node: { id: 'svc-cron', name: 'telegram-cron' } },
    ] },
    environments: { edges: [{ node: { id: 'env-prod', name: 'production' } }] },
  } });
} else if (document.includes('deployments(')) {
  reply({ deployments: {
    edges: [{ node: { id: 'dep-1', status: 'SUCCESS', createdAt: '2026-10-15T12:00:00.000Z', staticUrl: null, meta: null } }],
    pageInfo: { hasNextPage: false, endCursor: null },
  } });
} else if (document.includes('environmentLogs')) {
  reply({ environmentLogs: [] });
} else {
  console.error('unexpected document ' + document);
  process.exit(1);
}
`;

const railway = (project: string, service: string, environment?: string) => ({
  provider: 'railway',
  project,
  service,
  ...(environment === undefined ? {} : { environment }),
});

let dir: string;

const configWith = (services: Record<string, object>) => {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      projects: {
        app: {
          matcher: { type: 'git', repo: 'acme/app' },
          railway: { auth: 'cli' },
          services,
        },
      },
    }),
  );
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'traces-railway-fallback-'));
  const bin = join(dir, 'railway');
  writeFileSync(bin, FAKE_RAILWAY);
  chmodSync(bin, 0o755);
});

const run = async (
  command: 'logs' | 'deploys' | 'errors',
  service: string,
  config: string,
  extra: Record<string, string> = {},
) => {
  const child = Bun.spawn(
    [
      'bun',
      'src/main.ts',
      command,
      service,
      '--project',
      'app',
      '--config',
      config,
      '--json',
      ...(command === 'errors' ? ['--source', 'logs'] : []),
    ],
    {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...extra },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

const NOTE =
  'telegram-cron is not in the config; using Railway service "telegram-cron" in project proj-1. Add it (or run traces init).';

describe('a service the config does not list', () => {
  test('deploys resolves it in the one Railway project the config uses, and says so', async () => {
    const config = configWith({ api: railway('proj-1', 'api', 'production') });
    const result = await run('deploys', 'telegram-cron', config);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(NOTE);
    expect(result.stdout).toContain('"service":"telegram-cron"');
    expect(result.stdout).toContain('dep-1');
  });

  test('logs and errors take the same fallback', async () => {
    const config = configWith({ api: railway('proj-1', 'api') });
    for (const command of ['logs', 'errors'] as const) {
      const result = await run(command, 'telegram-cron', config);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(NOTE);
    }
  });

  test('a configured service prints no note', async () => {
    const config = configWith({ api: railway('proj-1', 'api') });
    const result = await run('deploys', 'api', config);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('not in the config');
  });

  test('a name Railway does not know fails with the Railway project services listed', async () => {
    const config = configWith({ api: railway('proj-1', 'api') });
    const result = await run('deploys', 'nope', config);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('available services: api (svc-api)');
  });

  test('Railway services in two projects exit 2 without guessing one', async () => {
    const config = configWith({
      api: railway('proj-1', 'api'),
      other: railway('proj-2', 'other'),
    });
    const result = await run('deploys', 'telegram-cron', config);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'no service named "telegram-cron" in project "app"',
    );
    expect(result.stderr).toContain('available services in "app": api, other');
    expect(result.stderr).not.toContain('Railway project');
  });

  test('one project in two environments exits 2, and the hint lists the Railway project services', async () => {
    const config = configWith({
      api: railway('proj-1', 'api', 'production'),
      staging: railway('proj-1', 'api', 'staging'),
    });
    const result = await run('logs', 'telegram-cron', config);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'Railway project proj-1 has: api, telegram-cron',
    );
  });

  test('when Railway cannot be reached the hint just omits its services', async () => {
    const config = configWith({
      api: railway('proj-1', 'api', 'production'),
      staging: railway('proj-1', 'api', 'staging'),
    });
    const result = await run('logs', 'telegram-cron', config, {
      FAKE_RAILWAY_DOWN: '1',
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'available services in "app": api, staging',
    );
    expect(result.stderr).not.toContain('Railway project');
  });

  test('a config with no Railway service has nothing to fall back to', async () => {
    const config = configWith({
      web: { provider: 'vercel', project: 'prj_1' },
    });
    const result = await run('deploys', 'telegram-cron', config);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('available services in "app": web');
  });
});
