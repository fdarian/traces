import { describe, expect, test } from 'bun:test';
import { ProviderAuthError, ProviderNotFound } from '@traces/core';
import { Effect } from 'effect';
import { CliError } from 'effect/cli';
import { ConfigError, UsageError } from '#/errors.ts';
import { parseLevels } from '#/levels.ts';
import {
  commandLine,
  EXIT_CODES,
  formatLogLine,
  renderError,
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
  test('puts continuation lines under the first', () => {
    const line = formatLogLine({
      ts: new Date().toISOString(),
      service: 'api',
      provider: 'railway',
      environment: 'production',
      deploymentId: 'abcdef123456',
      source: 'runtime',
      level: 'error',
      message: 'first\nsecond',
      attrs: {},
    });
    const lines = line.split('\n');
    expect(lines[0]).toMatch(
      /^\d\d:\d\d:\d\d\.\d{3} ERROR api abcdef12 first$/,
    );
    expect(lines[1]).toBe('    second');
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
