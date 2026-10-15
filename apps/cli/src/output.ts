import {
  type Deployment,
  firstLine,
  InvalidCursor,
  JaegerBadResponse,
  JaegerUnreachable,
  type LogRecord,
  type Provider,
  ProviderAuthError,
  ProviderNotFound,
  ProviderRequestError,
  ProviderResponseInvalid,
  type SpanRow,
  stripAnsi,
  TraceBackendUnauthorized,
  TraceErrorCountsUnavailable,
  TraceNotFound,
  type TraceRow,
} from '@traces/core';
import { Console, Effect, Schema } from 'effect';
import { CliError, CliOutput } from 'effect/cli';
import { ConfigError, EnvVarMissing, UsageError } from '#/errors.ts';
import { SHORTEST_RETENTION_MS } from '#/limits.ts';
import { SecretMissing, SecretStoreError } from '#/secrets.ts';

export type OutputMode = 'human' | 'ndjson';

export const outputMode = (jsonFlag: boolean): OutputMode =>
  jsonFlag || process.stdout.isTTY !== true ? 'ndjson' : 'human';

export const EXIT_CODES = {
  ok: 0,
  runtime: 1,
  usage: 2,
  auth: 3,
} as const;

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

/** Rebuilds a runnable command line for the stderr `more:` hint. */
export const commandLine = (
  subcommand: string,
  positional: ReadonlyArray<string>,
  flags: ReadonlyArray<
    readonly [name: string, value: string | boolean | undefined]
  >,
): string => {
  const parts = ['traces', subcommand, ...positional.map(shellQuote)];
  for (const [name, value] of flags) {
    if (value === undefined || value === false) continue;
    parts.push(value === true ? `--${name}` : `--${name} ${shellQuote(value)}`);
  }
  return parts.join(' ');
};

const pad = (value: number, width: number) =>
  String(value).padStart(width, '0');

const utcDate = (date: Date) =>
  `${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;

const formatTime = (iso: string, withDate: boolean): string => {
  const date = new Date(iso);
  const time = `${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}.${pad(date.getUTCMilliseconds(), 3)}Z`;
  return withDate ? `${utcDate(date)} ${time}` : time;
};

/** True when the window touches more than one UTC calendar day, so bare times would be ambiguous. */
export const windowSpansDays = (start: Date, end: Date): boolean =>
  start.toISOString().slice(0, 10) !== end.toISOString().slice(0, 10);

export const shortId = (id: string): string => id.slice(0, 8);

export const formatLogLine = (record: LogRecord, withDate: boolean): string => {
  const deployment =
    record.deploymentId === undefined ? '' : ` ${shortId(record.deploymentId)}`;
  const trace =
    record.traceId === undefined ? '' : ` trace=${shortId(record.traceId)}`;
  const lines = record.message.split('\n');
  const head = `${formatTime(record.ts, withDate)} ${record.level.toUpperCase().padEnd(5)} ${record.service}${deployment}${trace} ${lines.slice(0, 1).join('')}`;
  return [head, ...lines.slice(1).map((line) => `    ${line}`)].join('\n');
};

export const formatTraceLine = (row: TraceRow, withDate: boolean): string => {
  const errors =
    row.errorSpanCount === undefined || row.errorSpanCount === 0
      ? ''
      : ` ERR×${row.errorSpanCount}`;
  return `${formatTime(row.startTs, withDate)} ${row.durationMs}ms${errors} ${row.rootService} ${row.rootOperation}  ${shortId(row.traceId)}…`;
};

const STACK_FRAMES_SHOWN = 3;

/** JS-style `at ...` frames when present; any other format falls back to its first lines. */
const topFrames = (stacktrace: string): ReadonlyArray<string> => {
  const lines = stacktrace
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const frames = lines.filter((line) => line.startsWith('at '));
  return (frames.length > 0 ? frames : lines).slice(0, STACK_FRAMES_SHOWN);
};

const spanStatusMark = (row: SpanRow): string => {
  if (row.status === 'error') return ' ERR';
  return row.status === 'ok' ? ' ok' : '';
};

/** Indented tree, one block per span: offset from the trace start, duration, service, name; errors add the exception and its top frames. */
export const formatSpanTree = (
  rows: ReadonlyArray<SpanRow>,
): ReadonlyArray<string> => {
  const traceStart = Math.min(...rows.map((row) => Date.parse(row.startTs)));
  const cells = rows.map((row) => ({
    row,
    offset: `+${Date.parse(row.startTs) - traceStart}ms`,
    duration: `${row.durationMs}ms`,
  }));
  const offsetWidth = Math.max(...cells.map((cell) => cell.offset.length));
  const durationWidth = Math.max(...cells.map((cell) => cell.duration.length));
  const gutter = ' '.repeat(offsetWidth + durationWidth + 2);
  return cells.flatMap((cell) => {
    const indent = '  '.repeat(cell.row.depth);
    const head = `${cell.offset.padStart(offsetWidth)} ${cell.duration.padStart(durationWidth)} ${indent}${cell.row.service} ${cell.row.name}${spanStatusMark(cell.row)}`;
    const exception = cell.row.exception;
    const problem =
      exception !== undefined
        ? `${exception.type}: ${firstLine(exception.message)}`
        : cell.row.status === 'error' && cell.row.statusMessage !== undefined
          ? firstLine(cell.row.statusMessage)
          : undefined;
    if (problem === undefined) return [head];
    return [
      head,
      `${gutter}${indent}  ! ${problem}`,
      ...topFrames(exception?.stacktrace ?? '').map(
        (frame) => `${gutter}${indent}    ${frame}`,
      ),
    ];
  });
};

export const formatDeploymentLine = (deployment: Deployment): string => {
  const commit = deployment.commit;
  const sha = commit === undefined ? '-' : commit.sha.slice(0, 7);
  const branch = commit?.branch ?? '-';
  const message = commit?.message?.split('\n')[0] ?? '';
  const url = deployment.url === undefined ? '' : ` ${deployment.url}`;
  return `${deployment.status.padEnd(9)} ${shortId(deployment.id)} ${sha} ${branch} ${formatTime(deployment.createdAt, true)} ${message}${url}`.trimEnd();
};

export const emitRecord = <A>(
  mode: OutputMode,
  record: A,
  human: (record: A) => string,
) => Console.log(mode === 'ndjson' ? JSON.stringify(record) : human(record));

export const hint = (message: string) => Console.error(message);

/** The retention caveat only matters when the window reaches back past what the provider keeps; an unbounded window always does. */
export const retentionNoteFor = (
  source: { readonly provider: Provider; readonly retentionNote: string },
  windowStart: Date | undefined,
  now: Date,
): string | undefined =>
  windowStart === undefined ||
  now.getTime() - windowStart.getTime() > SHORTEST_RETENTION_MS[source.provider]
    ? source.retentionNote
    : undefined;

export const emptyNotice = (what: string, window: string, retention?: string) =>
  Console.error(
    retention === undefined
      ? `no ${what} ${window}`
      : `no ${what} ${window}\nnote: ${retention}`,
  );

export interface RenderedError {
  readonly message: string;
  readonly hint?: string;
  readonly code: number;
}

export const causeMessage = (cause: unknown): string => {
  if (Schema.isSchemaError(cause)) {
    return cause.message.slice(0, 600);
  }
  return cause instanceof Error ? cause.message : String(cause);
};

/** Parse failures can span lines (suggestions) and echo user input; one line keeps stderr greppable. */
const singleLine = (text: string): string =>
  text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();

const renderCliError = (error: CliError.CliError): RenderedError => {
  if (error._tag !== 'ShowHelp') {
    return {
      message: singleLine(error.message),
      hint: 'run `traces --help`',
      code: EXIT_CODES.usage,
    };
  }
  const command = error.commandPath.slice(1).join(' ');
  return {
    message:
      error.errors.length === 0
        ? 'invalid command line'
        : error.errors.map((cause) => singleLine(cause.message)).join('; '),
    hint: `run \`traces ${command === '' ? '' : `${command} `}--help\``,
    code: EXIT_CODES.usage,
  };
};

/** `unknown` because the CLI framework's own failures also land here. */
export const renderError = (error: unknown): RenderedError => {
  if (CliError.isCliError(error)) return renderCliError(error);
  if (error instanceof UsageError) {
    return { message: error.message, hint: error.hint, code: EXIT_CODES.usage };
  }
  if (error instanceof ConfigError) {
    return {
      message: `${error.path}: ${error.message}`,
      hint: error.hint,
      code: EXIT_CODES.usage,
    };
  }
  if (error instanceof ProviderAuthError) {
    return {
      message: `${error.provider}: not authorized`,
      hint: error.hint,
      code: EXIT_CODES.auth,
    };
  }
  if (error instanceof ProviderNotFound) {
    return {
      message: `${error.provider}: ${error.what} not found`,
      hint: error.hint,
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof ProviderRequestError) {
    return {
      message: `${error.provider}: request failed: ${causeMessage(error.cause)}`,
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof ProviderResponseInvalid) {
    return {
      message: `${error.provider}: unexpected ${error.operation} response shape: ${causeMessage(error.cause)}`,
      hint: 'the provider API may have changed; this is a bug in traces',
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof SecretMissing) {
    return {
      message: `secret "${error.name}" is not in the keychain`,
      hint: `traces secret set ${error.name}`,
      code: EXIT_CODES.auth,
    };
  }
  if (error instanceof SecretStoreError) {
    return {
      message: `keychain ${error.operation} of "${error.name}" failed: ${causeMessage(error.cause)}`,
      hint: 'unlock the keychain and retry',
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof EnvVarMissing) {
    return {
      message: `environment variable ${error.name} is not set`,
      hint: `export ${error.name}=<value> and retry`,
      code: EXIT_CODES.auth,
    };
  }
  if (error instanceof TraceBackendUnauthorized) {
    return {
      message: `tracing backend rejected the credentials (HTTP ${error.status})`,
      hint: 'check the secret behind the tracing headers: `traces services` shows each one; reset with `traces secret set <name>`',
      code: EXIT_CODES.auth,
    };
  }
  if (error instanceof JaegerUnreachable) {
    return {
      message: `tracing backend unreachable: ${causeMessage(error.cause)}`,
      hint: 'check tracing.url in the config and the network; `traces services` shows the URL',
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof JaegerBadResponse) {
    return {
      message: `tracing backend returned an unexpected response: ${causeMessage(error.cause)}`,
      hint: 'the URL may not point at a Jaeger v2 query service (/api/v3)',
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof TraceErrorCountsUnavailable) {
    return {
      message: `the tracing backend reports no error span counts (trace ${shortId(error.traceId)}), so --errors cannot filter`,
      hint: 'drop --errors and look for ERR in the output, or use `traces trace <id>` on a suspect trace',
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof TraceNotFound) {
    return {
      message: `trace ${error.traceId} not found`,
      hint: 'Jaeger keeps traces only as long as its storage backend does (in-memory Jaeger drops them on restart), so an old trace may have expired. Check it is the full traceId and that tracing.url points at the Jaeger that received it',
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof InvalidCursor) {
    return {
      message: 'invalid --cursor',
      hint: 'copy the cursor from the previous `more:` line unchanged',
      code: EXIT_CODES.usage,
    };
  }
  return { message: causeMessage(error), code: EXIT_CODES.runtime };
};

export const reportError = (rendered: RenderedError) =>
  Console.error(
    rendered.hint === undefined
      ? `error: ${rendered.message}`
      : `error: ${rendered.message}\nhint: ${rendered.hint}`,
  );

export class ExitWith extends Schema.TaggedError<ExitWith>()('ExitWith', {
  code: Schema.Number,
}) {}

/**
 * The framework prints the full usage block (to stdout) before failing a parse.
 * Its formatter returns this marker instead and `plainWhenPiped` drops it, so
 * the failure surfaces only as the one-line error from `reportError`.
 */
const SUPPRESSED_HELP = '\u0000traces:suppressed-help';

export const withoutFrameworkHelp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CliOutput.Formatter, {
    ...CliOutput.defaultFormatter({ colors: false }),
    formatHelpDoc: () => SUPPRESSED_HELP,
  });

const plainArgs = (args: ReadonlyArray<unknown>) =>
  args.map((arg) => (typeof arg === 'string' ? stripAnsi(arg) : arg));

/** The CLI framework colors its own messages; keep escapes out of piped output. */
export const plainWhenPiped = (
  base: Console.Console,
  tty: { readonly stdout: boolean; readonly stderr: boolean },
): Console.Console => ({
  ...base,
  log: (...args) => {
    if (args.length === 1 && args[0] === SUPPRESSED_HELP) return;
    base.log(...(tty.stdout ? args : plainArgs(args)));
  },
  error: (...args) => base.error(...(tty.stderr ? args : plainArgs(args))),
  warn: (...args) => base.warn(...(tty.stderr ? args : plainArgs(args))),
});

export const withPlainConsole = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Console.consoleWith((base) =>
    Effect.provideService(
      effect,
      Console.Console,
      plainWhenPiped(base, {
        stdout: process.stdout.isTTY === true,
        stderr: process.stderr.isTTY === true,
      }),
    ),
  );
