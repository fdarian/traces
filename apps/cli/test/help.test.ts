import { describe, expect, test } from 'bun:test';
import { Console, Effect } from 'effect';
import { deploysOptions } from '#/commands/deploys.ts';
import { errorsOptions } from '#/commands/errors.ts';
import { logsOptions } from '#/commands/logs.ts';
import { secretOptions } from '#/commands/secret.ts';
import { servicesOptions } from '#/commands/services.ts';
import { spansOptions } from '#/commands/spans.ts';
import { traceOptions } from '#/commands/trace.ts';
import {
  COMMAND_HELP,
  COMMAND_NAMES,
  type CommandName,
  GLOBAL_FLAGS,
  HELP_TEXT,
  renderCommandHelp,
  resolveHelpRequest,
} from '#/help.ts';
import {
  DEPLOYS_LIMIT,
  ERROR_CAP,
  ERROR_TRACE_CAP,
  LOGS_LIMIT,
  TRACE_SCAN_CAP,
} from '#/limits.ts';
import { plainWhenPiped } from '#/output.ts';

const OPTIONS: Record<CommandName, Record<string, unknown>> = {
  services: servicesOptions,
  logs: logsOptions,
  deploys: deploysOptions,
  errors: errorsOptions,
  spans: spansOptions,
  trace: traceOptions,
  secret: secretOptions,
};

const names: Array<CommandName> = [...COMMAND_NAMES];

const POSITIONALS = ['service', 'name', 'traceId'];

const definedFlags = (name: CommandName) =>
  Object.keys(OPTIONS[name])
    .filter((key) => !POSITIONALS.includes(key))
    .sort();

const documentedFlags = (name: CommandName) => {
  const help: {
    flags: ReadonlyArray<{ name: string }>;
    noGlobalFlags?: true;
  } = COMMAND_HELP[name];
  const globals = help.noGlobalFlags === true ? [] : GLOBAL_FLAGS;
  return [...help.flags, ...globals].map((flag) => flag.name).sort();
};

describe('command help', () => {
  test('covers every command', () => {
    expect<ReadonlyArray<string>>([...COMMAND_NAMES].sort()).toEqual(
      Object.keys(OPTIONS).sort(),
    );
  });

  test.each(names)('%s documents exactly the flags it defines', (name) => {
    expect(documentedFlags(name)).toEqual(definedFlags(name));
  });

  test.each(names)('%s help text mentions every defined flag', (name) => {
    const text = renderCommandHelp(name);
    for (const flag of definedFlags(name)) {
      expect(text).toContain(`--${flag}`);
    }
  });

  test.each(names)('%s help is plain text with usage and examples', (name) => {
    const text = renderCommandHelp(name);
    expect(text).not.toContain(String.fromCharCode(27));
    expect(text.startsWith(`traces ${name}`)).toBe(true);
    expect(text).toContain('EXAMPLES');
    expect(text).toContain(`traces ${name}`);
  });

  test('the top-level help lists every command and its flags', () => {
    for (const name of COMMAND_NAMES) {
      expect(HELP_TEXT).toContain(`traces ${name}`);
      for (const flag of definedFlags(name)) {
        expect(HELP_TEXT).toContain(`--${flag}`);
      }
    }
    expect(HELP_TEXT.split('\n').length).toBeLessThan(100);
  });

  test('help documents the repo traces.json lookup and configSource', () => {
    expect(HELP_TEXT).toContain('traces.json at the git root');
    expect(HELP_TEXT).toContain('--project <name> skips traces.json');
    expect(HELP_TEXT).toContain('safe to commit');
    const services = renderCommandHelp('services').replace(/\s+/g, ' ');
    expect(services).toContain('configSource (flag | repo | global)');
    expect(services).toContain('matchedBy (flag | path | git | repo)');
  });

  test('the top-level help states the --limit defaults and caps', () => {
    expect(HELP_TEXT).toContain(
      `logs --limit: default ${LOGS_LIMIT.default}, max ${LOGS_LIMIT.max}`,
    );
    expect(HELP_TEXT).toContain(
      `deploys --limit: default ${DEPLOYS_LIMIT.default}, max ${DEPLOYS_LIMIT.max}`,
    );
    expect(HELP_TEXT).toContain(`at most ${ERROR_CAP} error logs per service`);
  });

  test('logs help carries the Vercel 5xx caveat and errors help the partial-count caveat', () => {
    const flat = (name: CommandName) =>
      renderCommandHelp(name).replace(/\s+/g, ' ');
    expect(flat('logs')).toContain('only shows up with --http');
    expect(flat('errors')).toContain('counts are partial');
  });

  test('errors help documents --source, trace groups and both caps', () => {
    const text = renderCommandHelp('errors').replace(/\s+/g, ' ');
    expect(text).toContain('--source <logs|traces>');
    expect(text).toContain('traces trace <traceId>');
    expect(text).toContain(`At most ${ERROR_TRACE_CAP} error traces`);
    expect(text).toContain(`${TRACE_SCAN_CAP} traces are read`);
    expect(HELP_TEXT).toContain(
      `fetches at most ${ERROR_TRACE_CAP} error traces per service`,
    );
  });
});

describe('resolveHelpRequest', () => {
  test('bare invocation and help flags show the top-level help', () => {
    expect(resolveHelpRequest([])).toEqual({ kind: 'top' });
    expect(resolveHelpRequest(['--help'])).toEqual({ kind: 'top' });
    expect(resolveHelpRequest(['-h'])).toEqual({ kind: 'top' });
    expect(resolveHelpRequest(['help'])).toEqual({ kind: 'top' });
  });

  test('every spelling of command help resolves to that command', () => {
    for (const args of [
      ['logs', '--help'],
      ['logs', '-h'],
      ['help', 'logs'],
      ['logs', 'api', '--since', '1h', '--help'],
      ['--help', 'logs'],
    ]) {
      expect(resolveHelpRequest(args)).toEqual({
        kind: 'command',
        name: 'logs',
      });
    }
  });

  test('help for an unknown command is reported', () => {
    expect(resolveHelpRequest(['help', 'nope'])).toEqual({
      kind: 'unknown',
      name: 'nope',
    });
  });

  test('ordinary invocations are left to the command parser', () => {
    expect(resolveHelpRequest(['logs', 'api'])).toBeUndefined();
    expect(resolveHelpRequest(['logs', '--bogus'])).toBeUndefined();
  });
});

describe('framework usage suppression', () => {
  test('the usage block never reaches stdout and the failure is one stderr line', async () => {
    const run = Bun.spawn(['bun', 'src/main.ts', 'logs', '--bogus'], {
      cwd: import.meta.dir + '/..',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      run.stdout.text(),
      run.stderr.text(),
      run.exited,
    ]);
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'error: Unrecognized flag: --bogus in command traces logs\nhint: run `traces logs --help`\n',
    );
    expect(code).toBe(2);
  });
});

describe('plainWhenPiped', () => {
  const escape = String.fromCharCode(27);
  const capture = (tty: { stdout: boolean; stderr: boolean }) => {
    const seen: Array<string> = [];
    const base = {
      log: (...args: ReadonlyArray<unknown>) =>
        void seen.push(`log:${args.join(' ')}`),
      error: (...args: ReadonlyArray<unknown>) =>
        void seen.push(`error:${args.join(' ')}`),
      warn: (...args: ReadonlyArray<unknown>) =>
        void seen.push(`warn:${args.join(' ')}`),
    } as unknown as Console.Console;
    return { seen, console: plainWhenPiped(base, tty) };
  };

  test('strips escapes from piped streams only', () => {
    const colored = `${escape}[31mred${escape}[0m`;
    const piped = capture({ stdout: false, stderr: false });
    piped.console.error(colored);
    piped.console.log(colored);
    expect(piped.seen).toEqual(['error:red', 'log:red']);

    const tty = capture({ stdout: true, stderr: true });
    tty.console.error(colored);
    expect(tty.seen).toEqual([`error:${colored}`]);
  });

  test('logs and errors document --since deploy, and errors its baseline fields', () => {
    const flat = (name: CommandName) =>
      renderCommandHelp(name).replace(/\s+/g, ' ');
    expect(flat('logs')).toContain('latest ready deploy');
    expect(flat('errors')).toContain('new: true');
    expect(flat('errors')).toContain('deploymentId');
    expect(flat('errors')).toContain('baseline');
    expect(HELP_TEXT).toContain('traces errors --since deploy');
  });
});
