import { describe, expect, test } from 'bun:test';
import {
  JaegerBadResponse,
  type LogRecord,
  ProviderAuthError,
  ProviderNotFound,
  TraceAttributeSearchUnavailable,
} from '@traces/core';
import { Effect } from 'effect';
import { CliError } from 'effect/cli';
import { ConfigError, UsageError } from '#/errors.ts';
import { parseLevels } from '#/levels.ts';
import {
  commandLine,
  EXIT_CODES,
  formatLogLine,
  renderError,
  retentionNoteFor,
  windowSpansDays,
} from '#/output.ts';
import { parseWhen } from '#/time.ts';
import { vercelAuthFilePath } from '#/vercel-token.ts';

const now = new Date('2026-10-12T12:00:00.000Z');

describe('parseWhen', () => {
  test('parses relative durations against now', async () => {
    const since = await Effect.runPromise(parseWhen('--since', '30m', now));
    expect(since.toISOString()).toBe('2026-10-12T11:30:00.000Z');
    const days = await Effect.runPromise(parseWhen('--since', '2d', now));
    expect(days.toISOString()).toBe('2026-10-10T12:00:00.000Z');
  });

  test('parses ISO timestamps', async () => {
    const at = await Effect.runPromise(
      parseWhen('--since', '2026-10-12T08:00:00Z', now),
    );
    expect(at.toISOString()).toBe('2026-10-12T08:00:00.000Z');
  });

  test('rejects anything else with a usage error', async () => {
    for (const text of ['banana', '10', '1x', '12:00']) {
      const result = await Effect.runPromise(
        parseWhen('--since', text, now).pipe(Effect.result),
      );
      expect(result._tag).toBe('Failure');
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

  test('missing attribute search names the endpoint and the flag', () => {
    const rendered = renderError(
      new TraceAttributeSearchUnavailable({
        status: 404,
        url: 'https://host.example/api/traces',
      }),
    );
    expect(rendered.message).toBe(
      'attribute filters need the Jaeger legacy /api/traces endpoint, which answered HTTP 404 at https://host.example/api/traces',
    );
    expect(rendered.hint).toContain('drop --attr');
    expect(rendered.code).toBe(EXIT_CODES.runtime);
  });

  test('auth errors carry the hint', () => {
    expect(
      renderError(
        new ProviderAuthError({
          provider: 'railway',
          hint: 'run `railway login`',
        }),
      ).hint,
    ).toBe('run `railway login`');
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
    ).split('\n');
    expect(lines[0]).toBe('02:55:09.123Z ERROR api abcdef12 first');
    expect(lines[1]).toBe('    second');
  });

  test('shows a short trace id when the record has one', () => {
    const line = formatLogLine(
      { ...record('2026-10-14T02:55:09.123Z'), traceId: 'a'.repeat(32) },
      false,
    );
    expect(line.split('\n')[0]).toBe(
      '02:55:09.123Z ERROR api abcdef12 trace=aaaaaaaa first',
    );
  });

  test('prints UTC regardless of the local zone and prefixes the date on request', () => {
    expect(
      formatLogLine(record('2026-10-14T23:59:59.001+07:00'), true).split(
        '\n',
      )[0],
    ).toBe('10-14 16:59:59.001Z ERROR api abcdef12 first');
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
