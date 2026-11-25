import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineText, deploySinceText } from '#/deploy-window.ts';

const DEPLOY_AT = '2026-10-15T12:00:00.000Z';
const UNTIL = '2026-10-15T14:00:00Z';

const FAKE_RAILWAY = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const state = JSON.parse(require('node:fs').readFileSync(process.env.FAKE_RAILWAY_STATE, 'utf8'));
const document = args[1];
const vars = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--raw-var' || args[i] === '--var') {
    const [name, ...rest] = args[i + 1].split('=');
    vars[name] = rest.join('=');
  }
}
const reply = (data) => console.log(JSON.stringify({ data }));
if (document.includes('project(')) {
  reply({ project: {
    services: { edges: [{ node: { id: 'svc-api', name: 'api' } }] },
    environments: { edges: [{ node: { id: 'env-prod', name: 'production' } }] },
  } });
} else if (document.includes('deployments(')) {
  reply({ deployments: {
    edges: state.deployments.map((node) => ({ node })),
    pageInfo: { hasNextPage: false, endCursor: null },
  } });
} else if (document.includes('deploymentLogs') || document.includes('buildLogs')) {
  const rows = state.logs.slice(-(Number(vars.l) + 1));
  reply({ [document.includes('buildLogs') ? 'buildLogs' : 'deploymentLogs']: rows });
} else if (document.includes('environmentLogs')) {
  const before = Date.parse(vars.a);
  const since = vars.b === undefined ? -Infinity : Date.parse(vars.b);
  const rows = state.logs
    .filter((row) => Date.parse(row.timestamp) <= before && Date.parse(row.timestamp) >= since)
    // N+1 rows for a limit of N: the shape pageRailway reads as "older logs remain" (see core logs/paging.ts).
    .slice(-(Number(vars.l) + 1));
  reply({ environmentLogs: rows });
} else {
  console.error('unexpected document ' + document);
  process.exit(1);
}
`;

const logRow = (timestamp: string, message: string) => ({
  timestamp,
  message,
  severity: 'error',
  attributes: [],
  tags: { deploymentId: 'dep-new' },
});

const LOGS = [
  logRow('2026-10-15T11:00:00.000Z', 'ECONNRESET talking to 10.0.0.1'),
  logRow('2026-10-15T11:30:00.000Z', 'Pool exhausted after 30 waiters'),
  logRow('2026-10-15T12:10:00.000Z', 'ECONNRESET talking to 10.0.0.2'),
  logRow('2026-10-15T12:20:00.000Z', 'ECONNRESET talking to 10.0.0.3'),
  logRow(
    '2026-10-15T12:30:00.000Z',
    'Schema mismatch: column users.email missing',
  ),
];

const deployment = (id: string, status: string, createdAt: string) => ({
  id,
  status,
  createdAt,
  staticUrl: null,
  meta: null,
});

const DEPLOYMENTS = [
  deployment('dep-building', 'BUILDING', '2026-10-15T13:00:00.000Z'),
  deployment('dep-removed', 'REMOVED', '2026-10-14T09:00:00.000Z'),
  deployment('dep-new', 'SUCCESS', DEPLOY_AT),
  deployment('dep-older', 'SUCCESS', '2026-10-13T09:00:00.000Z'),
];

const TRACE_ERRORS = [
  // Before the deploy: the same failure the log baseline calls old, for traces.
  { id: 'a1'.repeat(16), at: '2026-10-15T11:10:00Z', message: 'no user 17' },
  { id: 'b2'.repeat(16), at: '2026-10-15T12:15:00Z', message: 'no user 902' },
  { id: 'c3'.repeat(16), at: '2026-10-15T12:45:00Z', message: 'fresh failure' },
];

const nanoOf = (iso: string) =>
  (BigInt(Date.parse(iso)) * 1_000_000n).toString();

const traceOf = (entry: (typeof TRACE_ERRORS)[number]) => ({
  result: {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'api-otel' } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: entry.id,
                spanId: 'span',
                name: 'GET /x',
                kind: 'SPAN_KIND_SERVER',
                startTimeUnixNano: nanoOf(entry.at),
                endTimeUnixNano: nanoOf(entry.at),
                status: { code: 'STATUS_CODE_ERROR' },
                events: [
                  {
                    name: 'exception',
                    timeUnixNano: nanoOf(entry.at),
                    attributes: [
                      {
                        key: 'exception.type',
                        value: { stringValue: 'TypeError' },
                      },
                      {
                        key: 'exception.message',
                        value: { stringValue: entry.message },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
});

const summaryOf = (entry: (typeof TRACE_ERRORS)[number]) => ({
  traceId: entry.id,
  rootServiceName: 'api-otel',
  rootOperationName: 'GET /x',
  spanCount: 1,
  errorSpanCount: 1,
  services: [{ name: 'api-otel', spanCount: 1 }],
  minStartTimeUnixNano: nanoOf(entry.at),
  maxEndTimeUnixNano: nanoOf(entry.at),
});

let dir: string;
let jaeger: Server;

const writeState = (
  name: string,
  deployments: ReadonlyArray<object>,
  logs: ReadonlyArray<object> = LOGS,
) => {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ deployments, logs }));
  return path;
};

const configFor = (withTracing: boolean) => {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      projects: {
        app: {
          matcher: { type: 'git', repo: 'acme/app' },
          railway: { auth: 'cli' },
          ...(withTracing
            ? {
                tracing: {
                  provider: 'jaeger',
                  url: `http://localhost:${(jaeger.address() as AddressInfo).port}/proxy`,
                },
              }
            : {}),
          services: {
            api: {
              provider: 'railway',
              project: 'p',
              service: 'api',
              environment: 'production',
              ...(withTracing ? { otelService: 'api-otel' } : {}),
            },
            ...(withTracing ? { jobs: { otelService: 'jobs-otel' } } : {}),
          },
        },
      },
    }),
  );
  return path;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'traces-deploy-window-'));
  const bin = join(dir, 'railway');
  writeFileSync(bin, FAKE_RAILWAY);
  chmodSync(bin, 0o755);
  jaeger = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const json = (body: unknown) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(body));
    if (url.pathname === '/proxy/api/v3/trace-summaries') {
      const min = Date.parse(
        url.searchParams.get('query.start_time_min') ?? '',
      );
      const max = Date.parse(
        url.searchParams.get('query.start_time_max') ?? '',
      );
      json({
        summaries: TRACE_ERRORS.filter(
          (entry) => Date.parse(entry.at) >= min && Date.parse(entry.at) <= max,
        ).map(summaryOf),
      });
      return;
    }
    const match = /\/proxy\/api\/v3\/traces\/(\w+)$/.exec(url.pathname);
    const entry = TRACE_ERRORS.find((candidate) => candidate.id === match?.[1]);
    if (entry === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    json(traceOf(entry));
  });
  await new Promise<void>((resolve) => jaeger.listen(0, resolve));
});

afterAll(() => {
  jaeger.close();
});

const spawnCli = async (
  command: 'errors' | 'logs' | 'deploys',
  args: ReadonlyArray<string>,
  config: string,
  state: string,
) => {
  const child = Bun.spawn(
    [
      'bun',
      'src/main.ts',
      command,
      '--project',
      'app',
      '--config',
      config,
      ...args,
    ],
    {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_RAILWAY_STATE: state,
      },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

const run = async (
  command: 'errors' | 'logs',
  args: ReadonlyArray<string>,
  config: string,
  state: string,
) => {
  const result = await spawnCli(command, [...args, '--json'], config, state);
  const rows = result.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { rows, stderr: result.stderr, code: result.code };
};

describe('traces errors --since deploy', () => {
  test('anchors on the latest ready deploy and marks groups the baseline never saw as new', async () => {
    const state = writeState('ready', DEPLOYMENTS);
    const result = await run(
      'errors',
      ['api', '--since', 'deploy', '--until', UNTIL, '--source', 'logs'],
      configFor(false),
      state,
    );
    expect(result.code).toBe(0);
    const byText = (text: string) =>
      result.rows.find((row) => String(row.sample).includes(text));
    expect(result.rows).toHaveLength(2);
    expect(byText('ECONNRESET')).toMatchObject({
      count: 2,
      new: false,
      deploymentId: 'dep-new',
      deployedAt: DEPLOY_AT,
    });
    expect(byText('Schema mismatch')).toMatchObject({
      count: 1,
      new: true,
      deploymentId: 'dep-new',
    });
    expect(result.stderr).toContain(
      'api: since deploy dep-new at 2026-10-15T12:00:00Z; baseline 2h before',
    );
    expect(byText('Schema mismatch')?.hint).toContain('--since deploy');
  });

  test('warns that groups may be wrongly new when the baseline reaches past retention', async () => {
    const state = writeState('retention-old', DEPLOYMENTS);
    const result = await run(
      'errors',
      ['api', '--since', 'deploy', '--until', UNTIL, '--source', 'logs'],
      configFor(false),
      state,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'note: api: the baseline reaches back past the shortest railway log retention; groups may be wrongly marked `new`.',
    );
  });

  test('says nothing about retention when the baseline is inside it', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const state = writeState(
      'retention-recent',
      [deployment('dep-recent', 'SUCCESS', recent)],
      [],
    );
    const result = await run(
      'errors',
      ['api', '--since', 'deploy', '--source', 'logs'],
      configFor(false),
      state,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('since deploy dep-recent');
    expect(result.stderr).not.toContain('retention');
  });

  test('without --since deploy the groups carry no new or deploy fields', async () => {
    const state = writeState('plain', DEPLOYMENTS);
    const result = await run(
      'errors',
      [
        'api',
        '--since',
        '2026-10-15T11:00:00Z',
        '--until',
        UNTIL,
        '--source',
        'logs',
      ],
      configFor(false),
      state,
    );
    expect(result.code).toBe(0);
    for (const row of result.rows) {
      expect(row).not.toHaveProperty('new');
      expect(row).not.toHaveProperty('deploymentId');
      expect(row).not.toHaveProperty('deployedAt');
    }
  });

  test('trace groups compare against a trace baseline, and trace-only services are skipped with a note', async () => {
    const state = writeState('traces', DEPLOYMENTS);
    const result = await run(
      'errors',
      ['--since', 'deploy', '--until', UNTIL],
      configFor(true),
      state,
    );
    expect(result.code).toBe(0);
    const traces = result.rows.filter((row) => row.source === 'traces');
    expect(
      traces.map((row) => [row.sample, row.new, row.deploymentId]),
    ).toEqual(
      expect.arrayContaining([
        ['TypeError: no user 902', false, 'dep-new'],
        ['TypeError: fresh failure', true, 'dep-new'],
      ]),
    );
    expect(result.stderr).toContain('jobs: trace-only, no deploys; skipped');
    expect(result.stderr).not.toContain('jobs: since deploy');
  });

  test('no ready deploy exits 1 and points at traces deploys', async () => {
    const state = writeState('none', [
      deployment('dep-building', 'BUILDING', '2026-10-15T13:00:00.000Z'),
      deployment('dep-removed', 'REMOVED', '2026-10-14T09:00:00.000Z'),
    ]);
    const result = await run(
      'errors',
      ['api', '--since', 'deploy', '--source', 'logs'],
      configFor(false),
      state,
    );
    expect(result.code).toBe(1);
    expect(result.rows).toEqual([]);
    expect(result.stderr).toContain('api has no ready deployment');
    expect(result.stderr).toContain('hint: traces deploys api');
  });

  test('--until deploy is a usage error', async () => {
    const state = writeState('until', DEPLOYMENTS);
    const result = await run(
      'errors',
      ['api', '--until', 'deploy'],
      configFor(false),
      state,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--until does not accept');
  });
});

describe('baselineText', () => {
  const at = new Date('2026-10-15T12:00:00Z');
  const baseline = (ms: number) =>
    baselineText({
      deployment: deployment('dep', 'SUCCESS', DEPLOY_AT) as never,
      since: at,
      baselineSince: new Date(at.getTime() - ms),
    });

  test('minutes that round up to an hour carry into the hours', () => {
    expect(baseline(119.6 * 60_000)).toBe('baseline 2h before');
    expect(baseline(59.6 * 60_000)).toBe('baseline 1h before');
    expect(baseline(90 * 60_000)).toBe('baseline 1h30m before');
    expect(baseline(45 * 60_000)).toBe('baseline 45m before');
  });
});

describe('traces errors --since deploy window checks', () => {
  const AHEAD = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  test('a deploy ahead of the local clock blames the clock when --until is absent', async () => {
    const state = writeState('ahead', [
      deployment('dep-future', 'SUCCESS', AHEAD),
    ]);
    const result = await run(
      'errors',
      ['api', '--since', 'deploy', '--source', 'logs'],
      configFor(false),
      state,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("ahead of this machine's clock");
    expect(result.stderr).not.toContain('--until');
  });

  test('--until before the deploy still blames --until', async () => {
    const state = writeState('until-before', DEPLOYMENTS);
    const result = await run(
      'errors',
      [
        'api',
        '--since',
        'deploy',
        '--until',
        '2026-10-15T11:00:00Z',
        '--source',
        'logs',
      ],
      configFor(false),
      state,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--until is not after the latest ready');
  });

  test('logs --since deploy rejects the same two cases', async () => {
    const ahead = await run(
      'logs',
      ['api', '--since', 'deploy'],
      configFor(false),
      writeState('logs-ahead', [deployment('dep-future', 'SUCCESS', AHEAD)]),
    );
    expect(ahead.code).toBe(2);
    expect(ahead.stderr).toContain("ahead of this machine's clock");
    const before = await run(
      'logs',
      ['api', '--since', 'deploy', '--until', '2026-10-15T11:00:00Z'],
      configFor(false),
      writeState('logs-until-before', DEPLOYMENTS),
    );
    expect(before.code).toBe(2);
    expect(before.stderr).toContain('--until is not after the latest ready');
  });
});

describe('an inverted window', () => {
  for (const command of ['logs', 'errors'] as const) {
    test(`${command} rejects --since at or after --until with exit 2`, async () => {
      const state = writeState(`inverted-${command}`, DEPLOYMENTS);
      for (const [since, until] of [
        ['2026-10-15T13:00:00Z', '2026-10-15T12:00:00Z'],
        ['2026-10-15T12:00:00Z', '2026-10-15T12:00:00Z'],
      ] as const) {
        const result = await run(
          command,
          ['api', '--since', since, '--until', until],
          configFor(false),
          state,
        );
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('--since is not before --until');
        expect(result.rows).toEqual([]);
      }
    });

    test(`${command} rejects a --since in the future when --until is absent`, async () => {
      const state = writeState(`future-${command}`, DEPLOYMENTS);
      const result = await run(
        command,
        ['api', '--since', '2999-01-01T00:00:00Z'],
        configFor(false),
        state,
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--since is not before now');
    });
  }
});

describe('traces logs --deploy latest', () => {
  const NEWEST = deployment('dep-newest', 'SUCCESS', DEPLOY_AT);

  test('the more: command pins the resolved deployment, not the word latest', async () => {
    const state = writeState('latest-more', [NEWEST, DEPLOYMENTS[3] as object]);
    const result = await spawnCli(
      'logs',
      [
        'api',
        '--deploy',
        'latest',
        '--since',
        '2026-10-15T00:00:00Z',
        '--limit',
        '2',
      ],
      configFor(false),
      state,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('--deploy dep-newest');
    expect(result.stderr).not.toContain('--deploy latest');
  });

  test('--build defaults to latest and its more: command pins the deployment too', async () => {
    const state = writeState('build-more', [NEWEST]);
    const result = await spawnCli(
      'logs',
      ['api', '--build', '--limit', '2'],
      configFor(false),
      state,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('--deploy dep-newest');
  });
});

describe('traces logs --since deploy', () => {
  test('starts the window at the deploy and says which one on stderr', async () => {
    const state = writeState('logs', DEPLOYMENTS);
    const result = await run(
      'logs',
      ['api', '--since', 'deploy', '--until', UNTIL, '--level', 'error'],
      configFor(false),
      state,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'since deploy dep-new at 2026-10-15T12:00:00Z',
    );
    expect(result.rows.map((row) => row.ts)).toEqual([
      '2026-10-15T12:10:00.000Z',
      '2026-10-15T12:20:00.000Z',
      '2026-10-15T12:30:00.000Z',
    ]);
  });
});

describe('traces errors partial coverage', () => {
  const FLOOD_START = Date.parse('2026-10-15T11:00:00.000Z');
  const flood = Array.from({ length: 2001 }, (_, index) =>
    logRow(
      new Date(FLOOD_START + index * 1000).toISOString(),
      `ECONNRESET talking to 10.0.0.${index}`,
    ),
  );

  test('a capped log service says which time range its counts cover', async () => {
    const state = writeState('flood', DEPLOYMENTS, flood);
    const result = await run(
      'errors',
      [
        'api',
        '--since',
        '2026-10-15T10:00:00Z',
        '--until',
        UNTIL,
        '--source',
        'logs',
      ],
      configFor(false),
      state,
    );
    expect(result.code).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      count: 2000,
      lines: 2000,
      partial: true,
      // The oldest of the 2001 rows is the one the cap dropped.
      countedSince: '2026-10-15T11:00:01.000Z',
    });
    expect(result.stderr).toContain(
      'note: hit the 2000-log cap; counts cover 2026-10-15T11:00:01Z -> 2026-10-15T14:00:00Z, not the whole window from 2026-10-15T10:00:00Z. Narrow --since for exact counts.',
    );
  });

  test('a service that read its whole window has no countedSince', async () => {
    const state = writeState('whole', DEPLOYMENTS);
    const result = await run(
      'errors',
      [
        'api',
        '--since',
        '2026-10-15T10:00:00Z',
        '--until',
        UNTIL,
        '--source',
        'logs',
      ],
      configFor(false),
      state,
    );
    expect(result.rows.every((row) => row.partial === false)).toBe(true);
    expect(result.rows.some((row) => 'countedSince' in row)).toBe(false);
    expect(result.stderr).not.toContain('counts cover');
  });
});

describe('text output when piped', () => {
  const LONG_DEPLOY = '0123456789abcdef0123456789abcdef';
  const LONG_TRACE = 'd4'.repeat(16);
  const stateWithLongIds = () =>
    writeState(
      'long-ids',
      [deployment(LONG_DEPLOY, 'SUCCESS', DEPLOY_AT)],
      [
        {
          ...logRow('2026-10-15T12:10:00.000Z', 'ECONNRESET talking to db'),
          tags: { deploymentId: LONG_DEPLOY },
          attributes: [{ key: 'traceId', value: LONG_TRACE }],
        },
      ],
    );

  test('logs prints the full deployment and trace ids, with no ANSI codes', async () => {
    const result = await spawnCli(
      'logs',
      ['api', '--since', '2026-10-15T12:00:00Z', '--until', UNTIL],
      configFor(false),
      stateWithLongIds(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `deploy ${LONG_DEPLOY}\n12:10:00.000Z ERROR api trace=${LONG_TRACE} ECONNRESET talking to db\n`,
    );
    expect(result.stdout).not.toContain('\u001b');
    expect(result.stdout).not.toContain('…');
  });

  test('logs prints a deploy line again only when the deployment changes', async () => {
    const state = writeState(
      'deploy-headers',
      [deployment('dep-a', 'SUCCESS', DEPLOY_AT)],
      [
        {
          ...logRow('2026-10-15T12:10:00.000Z', 'one'),
          tags: { deploymentId: 'dep-a' },
        },
        {
          ...logRow('2026-10-15T12:11:00.000Z', 'two'),
          tags: { deploymentId: 'dep-a' },
        },
        {
          ...logRow('2026-10-15T12:12:00.000Z', 'three'),
          tags: { deploymentId: 'dep-b' },
        },
        { ...logRow('2026-10-15T12:13:00.000Z', 'four'), tags: {} },
        {
          ...logRow('2026-10-15T12:14:00.000Z', 'five'),
          tags: { deploymentId: 'dep-a' },
        },
      ],
    );
    const result = await spawnCli(
      'logs',
      ['api', '--since', '2026-10-15T12:00:00Z', '--until', UNTIL],
      configFor(false),
      state,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        'deploy dep-a',
        '12:10:00.000Z ERROR api one',
        '12:11:00.000Z ERROR api two',
        'deploy dep-b',
        '12:12:00.000Z ERROR api three',
        '12:13:00.000Z ERROR api four',
        'deploy dep-a',
        '12:14:00.000Z ERROR api five',
        '',
      ].join('\n'),
    );
  });

  test('deploys prints the full deployment id', async () => {
    const result = await spawnCli(
      'deploys',
      ['api'],
      configFor(false),
      stateWithLongIds(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `ready     ${LONG_DEPLOY} - - 10-15 12:00:00.000Z\n`,
    );
  });

  test('errors prints the full deployment and trace ids of its groups', async () => {
    const result = await spawnCli(
      'errors',
      [
        'api',
        '--since',
        '2026-10-15T12:00:00Z',
        '--until',
        UNTIL,
        '--source',
        'logs',
      ],
      configFor(false),
      stateWithLongIds(),
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.split('\n');
    expect(lines[0]).toBe(
      `1x api 2026-10-15T12:10:00.000Z -> 2026-10-15T12:10:00.000Z deploys ${LONG_DEPLOY} trace=${LONG_TRACE}`,
    );
    expect(lines[1]).toBe('       ECONNRESET talking to db');
    expect(result.stdout).not.toContain('\u001b');
  });

  test('the deploy lines on stderr carry the full deployment id', async () => {
    const logs = await spawnCli(
      'logs',
      ['api', '--since', 'deploy', '--until', UNTIL],
      configFor(false),
      stateWithLongIds(),
    );
    expect(logs.code).toBe(0);
    expect(logs.stderr).toContain(
      `since deploy ${LONG_DEPLOY} at 2026-10-15T12:00:00Z`,
    );
    const errors = await spawnCli(
      'errors',
      ['api', '--since', 'deploy', '--until', UNTIL, '--source', 'logs'],
      configFor(false),
      stateWithLongIds(),
    );
    expect(errors.code).toBe(0);
    expect(errors.stderr).toContain(
      `api: since deploy ${LONG_DEPLOY} at 2026-10-15T12:00:00Z; baseline 2h before`,
    );
  });

  test('--until before the deploy names the full deployment id', async () => {
    const result = await spawnCli(
      'errors',
      [
        'api',
        '--since',
        'deploy',
        '--until',
        '2026-10-15T11:00:00Z',
        '--source',
        'logs',
      ],
      configFor(false),
      stateWithLongIds(),
    );
    expect(result.stderr).toContain(
      `--until is not after the latest ready deploy (since deploy ${LONG_DEPLOY} at 2026-10-15T12:00:00Z)`,
    );
  });
});

describe('deploySinceText', () => {
  const longDeployment = {
    id: '0123456789abcdef0123456789abcdef',
    provider: 'railway',
    status: 'ready',
    createdAt: DEPLOY_AT,
  } as unknown as Parameters<typeof deploySinceText>[0];
  const since = new Date(DEPLOY_AT);

  test('shortens the id for a terminal', () => {
    expect(deploySinceText(longDeployment, since, true)).toBe(
      'since deploy 01234567 at 2026-10-15T12:00:00Z',
    );
  });

  test('keeps the full id when not a terminal', () => {
    expect(deploySinceText(longDeployment, since, false)).toBe(
      `since deploy ${longDeployment.id} at 2026-10-15T12:00:00Z`,
    );
  });
});
