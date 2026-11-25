import { describe, expect, test } from 'bun:test';
import {
  type Deployment,
  JaegerBadResponse,
  type LogRecord,
  ProviderAuthError,
  ProviderNotFound,
  ProviderToolMissing,
} from '@traces/core';
import { Cause, Console, Context, Effect, Exit } from 'effect';
import { CliError, type CliOutput, type HelpDoc } from 'effect/cli';
import { recordKey } from '#/commands/logs.ts';
import { ConfigError, UsageError } from '#/errors.ts';
import { parseLevels } from '#/levels.ts';
import {
  commandLine,
  deploymentHeader,
  EXIT_CODES,
  ExitWith,
  exitReport,
  formatDeploymentLine,
  formatLogLine,
  parseErrorPresenter,
  renderError,
  retentionNoteFor,
  windowSpansDays,
} from '#/output.ts';
import { parseInstant, parseWhen } from '#/time.ts';
import { vercelAuthFilePath } from '#/vercel-token.ts';

const now = new Date('2026-10-12T12:00:00.000Z');

describe('recordKey', () => {
  const record = (deploymentId: string | undefined): LogRecord => ({
    ts: '2026-10-12T12:00:00.000Z',
    service: 'api',
    provider: 'railway',
    environment: 'production',
    ...(deploymentId === undefined ? {} : { deploymentId }),
    source: 'runtime',
    level: 'info',
    message: 'hello',
    attrs: {},
  });

  test('an absent deployment id and an empty one are different keys', () => {
    expect(recordKey(record(undefined))).not.toBe(recordKey(record('')));
  });

  test('a separator inside a field cannot make two records collide', () => {
    expect(recordKey({ ...record('a'), message: 'b\0c' })).not.toBe(
      recordKey({ ...record('a\0b'), message: 'c' }),
    );
  });
});

describe('parseWhen', () => {
  const at = async (text: string) => {
    const when = await Effect.runPromise(parseWhen('--since', text, now));
    if (when._tag !== 'instant') throw new Error(`${text} is not an instant`);
    return when.at.toISOString();
  };

  test('parses relative durations against now', async () => {
    expect(await at('30m')).toBe('2026-10-12T11:30:00.000Z');
    expect(await at('2d')).toBe('2026-10-10T12:00:00.000Z');
  });

  test('parses ISO timestamps', async () => {
    expect(await at('2026-10-12T08:00:00Z')).toBe('2026-10-12T08:00:00.000Z');
  });

  test('the literal deploy is tagged, not resolved', async () => {
    expect(
      await Effect.runPromise(parseWhen('--since', 'deploy', now)),
    ).toEqual({ _tag: 'deploy' });
  });

  test('a duration past the Date range is a usage error naming the value', async () => {
    const result = await Effect.runPromise(
      parseWhen('--since', '99999999999d', now).pipe(Effect.flip),
    );
    expect(result).toBeInstanceOf(UsageError);
    expect(result.message).toContain('--since "99999999999d"');
  });

  test('rejects anything else with a usage error', async () => {
    for (const text of ['banana', '10', '1x', '12:00', 'Deploy', 'latest']) {
      const result = await Effect.runPromise(
        parseWhen('--since', text, now).pipe(Effect.result),
      );
      expect(result._tag).toBe('Failure');
    }
  });
});

describe('parseInstant', () => {
  test('returns the instant', async () => {
    const result = await Effect.runPromise(parseInstant('--until', '1h', now));
    expect(result.toISOString()).toBe('2026-10-12T11:00:00.000Z');
  });

  test('refuses deploy and says where it works', async () => {
    const result = await Effect.runPromise(
      parseInstant('--until', 'deploy', now).pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.message).toContain('--until does not accept');
      expect(result.failure.hint).toContain('logs and errors');
    }
  });
});

describe('parseLevels', () => {
  test('accepts comma lists and aliases', async () => {
    expect(
      await Effect.runPromise(parseLevels('error, warning,error')),
    ).toEqual(['error', 'warn']);
  });

  test('rejects unknown levels', async () => {
    const result = await Effect.runPromise(
      parseLevels('loud').pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
  });
});

describe('commandLine', () => {
  test('quotes values that need it and drops unset flags', () => {
    expect(
      commandLine(
        'logs',
        ['api'],
        [
          ['since', '1h'],
          ['grep', 'it\'s "bad"'],
          ['http', true],
          ['build', false],
          ['level', undefined],
          ['cursor', 'eyJ-_'],
        ],
      ),
    ).toBe(
      `traces logs api --since 1h --grep 'it'\\''s "bad"' --http --cursor eyJ-_`,
    );
  });
});

describe('renderError', () => {
  test('maps errors to the documented exit codes', () => {
    expect(renderError(new UsageError({ message: 'm', hint: 'h' })).code).toBe(
      EXIT_CODES.usage,
    );
    expect(
      renderError(new ConfigError({ path: '/c', message: 'm', hint: 'h' }))
        .code,
    ).toBe(EXIT_CODES.usage);
    expect(
      renderError(new ProviderAuthError({ provider: 'vercel', hint: 'h' }))
        .code,
    ).toBe(EXIT_CODES.auth);
    expect(
      renderError(
        new ProviderNotFound({ provider: 'railway', what: 'w', hint: 'h' }),
      ).code,
    ).toBe(EXIT_CODES.runtime);
    expect(
      renderError(
        new ProviderToolMissing({
          provider: 'railway',
          tool: 'railway',
          hint: 'h',
        }),
      ).code,
    ).toBe(EXIT_CODES.auth);
    expect(renderError(new Error('boom')).code).toBe(EXIT_CODES.runtime);
  });

  test('parse failures render as one line pointing at the command help', () => {
    const rendered = renderError(
      new CliError.ShowHelp({
        commandPath: ['traces', 'logs'],
        errors: [
          new CliError.UnrecognizedOption({
            option: '--bogus',
            command: ['traces', 'logs'],
            suggestions: ['--json'],
          }),
        ],
      }),
    );
    expect(rendered).toEqual({
      message:
        'Unrecognized flag: --bogus in command traces logs Did you mean this? --json',
      hint: 'run `traces logs --help`',
      code: EXIT_CODES.usage,
    });
  });

  test('a parse failure at the root points at the top-level help', () => {
    const rendered = renderError(
      new CliError.ShowHelp({
        commandPath: ['traces'],
        errors: [
          new CliError.UnknownSubcommand({
            subcommand: 'foo',
            parent: ['traces'],
            suggestions: [],
          }),
        ],
      }),
    );
    expect(rendered.hint).toBe('run `traces --help`');
    expect(rendered.code).toBe(EXIT_CODES.usage);
  });

  describe('JaegerBadResponse', () => {
    const badResponse = (fields: {
      status: number;
      contentType?: string;
      body: string;
    }) =>
      renderError(
        new JaegerBadResponse({
          cause: new Error('Expected a valid JSON string'),
          ...fields,
        }),
      );

    test('names the status, content-type and body', () => {
      const rendered = badResponse({
        status: 200,
        contentType: 'text/plain',
        body: 'pong',
      });
      expect(rendered.message).toBe(
        'tracing backend returned an unexpected response (HTTP 200, text/plain): Expected a valid JSON string; body: "pong"',
      );
      expect(rendered.code).toBe(EXIT_CODES.runtime);
    });

    test('an empty body without a content-type says so', () => {
      expect(badResponse({ status: 204, body: '' }).message).toContain(
        '(HTTP 204): Expected a valid JSON string; body: (empty)',
      );
    });

    test.each([
      ['by content-type', 'text/html; charset=utf-8', 'welcome'],
      ['by body', undefined, '<!DOCTYPE html><html>'],
    ])('an HTML page is recognised %s', (_label, contentType, body) => {
      expect(badResponse({ status: 200, contentType, body }).hint).toBe(
        'the URL serves a web page, not the Jaeger API; point `tracing.url` at the Jaeger query host',
      );
    });

    test('a redirect takes precedence over an HTML body', () => {
      expect(
        badResponse({
          status: 301,
          contentType: 'text/html',
          body: '<html>Moved</html>',
        }).hint,
      ).toBe('the URL redirects; use the final URL as tracing.url');
    });

    test('anything else keeps the generic hint', () => {
      expect(
        badResponse({
          status: 200,
          contentType: 'application/json',
          body: '{}',
        }).hint,
      ).toBe('the URL may not point at a Jaeger v2 query service (/api/v3)');
    });
  });

  test('auth errors carry the hint', () => {
    expect(
      renderError(
        new ProviderAuthError({
          provider: 'railway',
          hint: 'Railway rejected the token',
        }),
      ).hint,
    ).toBe('Railway rejected the token');
  });
});

describe('formatLogLine', () => {
  const record = (ts: string) =>
    ({
      ts,
      service: 'api',
      provider: 'railway',
      environment: 'production',
      deploymentId: 'abcdef123456',
      source: 'runtime',
      level: 'error',
      message: 'first\nsecond',
      attrs: {},
    }) satisfies LogRecord;

  test('puts continuation lines under the first', () => {
    const lines = formatLogLine(
      record('2026-10-14T02:55:09.123Z'),
      false,
      true,
    ).split('\n');
    expect(lines[0]).toBe('02:55:09.123Z ERROR api first');
    expect(lines[1]).toBe('    second');
  });

  test('shows a short trace id when the record has one on a terminal', () => {
    const line = formatLogLine(
      { ...record('2026-10-14T02:55:09.123Z'), traceId: 'a'.repeat(32) },
      false,
      true,
    );
    expect(line.split('\n')[0]).toBe(
      '02:55:09.123Z ERROR api trace=aaaaaaaa first',
    );
  });

  test('prints the full trace id when not on a terminal', () => {
    const line = formatLogLine(
      {
        ...record('2026-10-14T02:55:09.123Z'),
        traceId: 'a'.repeat(32),
        deploymentId: 'abcdef1234567890',
      },
      false,
      false,
    );
    expect(line.split('\n')[0]).toBe(
      `02:55:09.123Z ERROR api trace=${'a'.repeat(32)} first`,
    );
  });

  test('prints UTC regardless of the local zone and prefixes the date on request', () => {
    expect(
      formatLogLine(record('2026-10-14T23:59:59.001+07:00'), true, true).split(
        '\n',
      )[0],
    ).toBe('10-14 16:59:59.001Z ERROR api first');
  });
});

describe('deploymentHeader', () => {
  const record = (deploymentId: string | undefined) =>
    ({
      ts: '2026-10-14T02:55:09.123Z',
      service: 'api',
      provider: 'railway',
      environment: 'production',
      deploymentId,
      source: 'runtime',
      level: 'info',
      message: 'hello',
      attrs: {},
    }) satisfies LogRecord;

  test('opens a block for a deployment that is not the last one printed', () => {
    expect(deploymentHeader(record('abcdef1234567890'), undefined, false)).toBe(
      'deploy abcdef1234567890',
    );
    expect(deploymentHeader(record('bbbb'), 'aaaa', false)).toBe('deploy bbbb');
  });

  test('shortens the id on a terminal', () => {
    expect(deploymentHeader(record('abcdef1234567890'), undefined, true)).toBe(
      'deploy abcdef12',
    );
  });

  test('prints nothing for the same deployment or a record without one', () => {
    expect(deploymentHeader(record('aaaa'), 'aaaa', false)).toBeUndefined();
    expect(
      deploymentHeader(record(undefined), undefined, false),
    ).toBeUndefined();
    expect(deploymentHeader(record(undefined), 'aaaa', false)).toBeUndefined();
  });
});

describe('windowSpansDays', () => {
  test('compares UTC calendar days', () => {
    const at = (iso: string) => new Date(iso);
    expect(
      windowSpansDays(at('2026-10-14T01:00:00Z'), at('2026-10-14T23:00:00Z')),
    ).toBe(false);
    expect(
      windowSpansDays(at('2026-10-14T23:30:00Z'), at('2026-10-15T00:10:00Z')),
    ).toBe(true);
  });
});

describe('retentionNoteFor', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const railway = {
    provider: 'railway',
    retentionNote: 'railway note',
  } as const;
  const vercel = { provider: 'vercel', retentionNote: 'vercel note' } as const;
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const HOUR = 60 * 60 * 1000;

  test('is omitted while the window starts inside the shortest retention', () => {
    expect(retentionNoteFor(railway, ago(2 * 24 * HOUR), now)).toBeUndefined();
    expect(retentionNoteFor(vercel, ago(HOUR), now)).toBeUndefined();
  });

  test('appears once the window starts past it', () => {
    expect(retentionNoteFor(railway, ago(4 * 24 * HOUR), now)).toBe(
      'railway note',
    );
    expect(retentionNoteFor(vercel, ago(2 * HOUR), now)).toBe('vercel note');
  });

  test('appears for an unbounded window', () => {
    expect(retentionNoteFor(railway, undefined, now)).toBe('railway note');
  });
});

describe('vercelAuthFilePath', () => {
  test('uses the platform-specific location', () => {
    expect(vercelAuthFilePath('darwin', '/Users/u', undefined)).toBe(
      '/Users/u/Library/Application Support/com.vercel.cli/auth.json',
    );
    expect(vercelAuthFilePath('linux', '/home/u', undefined)).toBe(
      '/home/u/.local/share/com.vercel.cli/auth.json',
    );
    expect(vercelAuthFilePath('linux', '/home/u', '/data')).toBe(
      '/data/com.vercel.cli/auth.json',
    );
  });
});

describe('parseErrorPresenter', () => {
  const helpDoc: HelpDoc.HelpDoc = {
    description: 'd',
    usage: 'traces',
    flags: [],
    annotations: Context.empty(),
  };

  const stdoutOf = (event: CliOutput.Presenter.Event) => {
    const lines: Array<unknown> = [];
    Effect.runSync(
      Console.consoleWith((base) =>
        Effect.provideService(
          parseErrorPresenter.present(event),
          Console.Console,
          {
            ...base,
            log: (...args) => {
              lines.push(...args);
            },
          },
        ),
      ),
    );
    return lines;
  };

  test('prints no usage block for an invalid invocation', () => {
    expect(
      stdoutOf({
        _tag: 'InvalidInvocation',
        commandPath: ['traces'],
        helpDoc,
        errors: [],
      }),
    ).toEqual([]);
  });

  test('still prints requested help', () => {
    expect(
      stdoutOf({
        _tag: 'Help',
        reason: 'Requested',
        commandPath: ['traces'],
        helpDoc,
      }).join('\n'),
    ).toContain('USAGE');
  });
});

describe('formatDeploymentLine', () => {
  const deployment = {
    id: '0123456789abcdef',
    status: 'ready',
    createdAt: '2026-10-15T12:00:00.000Z',
    commit: { sha: 'abcdef0123456', branch: 'main', message: 'fix\nbody' },
    url: 'https://x.example.com',
  } as Deployment;

  test('shortens the id and the commit sha on a terminal', () => {
    expect(formatDeploymentLine(deployment, true)).toBe(
      'ready     01234567 abcdef0 main 10-15 12:00:00.000Z fix https://x.example.com',
    );
  });

  test('keeps the full id and the full commit sha when not on a terminal', () => {
    expect(formatDeploymentLine(deployment, false)).toBe(
      'ready     0123456789abcdef abcdef0123456 main 10-15 12:00:00.000Z fix https://x.example.com',
    );
  });

  test('a deployment without a commit prints a dash either way', () => {
    const bare = { ...deployment, commit: undefined } as Deployment;
    expect(formatDeploymentLine(bare, true)).toContain(' - - ');
    expect(formatDeploymentLine(bare, false)).toContain(' - - ');
  });
});

describe('exitReport', () => {
  test('success and interrupts print nothing', () => {
    expect(exitReport(Exit.succeed(undefined), false)).toEqual({ code: 0 });
    expect(exitReport(Exit.failCause(Cause.interrupt()), false)).toEqual({
      code: 130,
    });
  });

  test('an already-reported failure only carries its exit code', () => {
    expect(exitReport(Exit.fail(new ExitWith({ code: 3 })), false)).toEqual({
      code: 3,
    });
  });

  test('a thrown defect exits 1 with error and hint lines, no stack', () => {
    const report = exitReport(
      Exit.die(new RangeError('Invalid time value')),
      false,
    );
    expect(report.code).toBe(1);
    expect(report.stderr).toBe(
      'error: Invalid time value\nhint: this is a bug in traces; rerun with TRACES_DEBUG=1 for the stack',
    );
  });

  test('TRACES_DEBUG adds the stack', () => {
    const report = exitReport(
      Exit.die(new RangeError('Invalid time value')),
      true,
    );
    expect(report.stderr).toStartWith('error: Invalid time value\nhint: ');
    expect(report.stderr).toContain('RangeError');
    expect(report.stderr).toContain('at ');
  });
});
