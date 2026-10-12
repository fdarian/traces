import { ValidationError } from '@effect/cli';
import {
  type Deployment,
  InvalidCursor,
  type LogRecord,
  ProviderAuthError,
  ProviderNotFound,
  ProviderRequestError,
  ProviderResponseInvalid,
} from '@traces/core';
import { Console, ParseResult, Schema } from 'effect';
import { ConfigError, UsageError } from '#/errors.ts';

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

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  const time = `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? time
    : `${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)} ${time}`;
};

export const shortId = (id: string): string => id.slice(0, 8);

export const formatLogLine = (record: LogRecord): string => {
  const deployment =
    record.deploymentId === undefined ? '' : ` ${shortId(record.deploymentId)}`;
  const lines = record.message.split('\n');
  const head = `${formatTime(record.ts)} ${record.level.toUpperCase().padEnd(5)} ${record.service}${deployment} ${lines.slice(0, 1).join('')}`;
  return [head, ...lines.slice(1).map((line) => `    ${line}`)].join('\n');
};

export const formatDeploymentLine = (deployment: Deployment): string => {
  const commit = deployment.commit;
  const sha = commit === undefined ? '-' : commit.sha.slice(0, 7);
  const branch = commit?.branch ?? '-';
  const message = commit?.message?.split('\n')[0] ?? '';
  const url = deployment.url === undefined ? '' : ` ${deployment.url}`;
  return `${deployment.status.padEnd(9)} ${shortId(deployment.id)} ${sha} ${branch} ${formatTime(deployment.createdAt)} ${message}${url}`.trimEnd();
};

export const emitRecord = <A>(
  mode: OutputMode,
  record: A,
  human: (record: A) => string,
) => Console.log(mode === 'ndjson' ? JSON.stringify(record) : human(record));

export const hint = (message: string) => Console.error(message);

export const emptyNotice = (what: string, window: string, retention: string) =>
  Console.error(`no ${what} ${window}\nnote: ${retention}`);

export interface RenderedError {
  readonly message: string;
  readonly hint?: string;
  readonly code: number;
  /** The CLI framework already printed this failure. */
  readonly alreadyReported?: boolean;
}

const causeMessage = (cause: unknown): string => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.TreeFormatter.formatErrorSync(cause).slice(0, 600);
  }
  return cause instanceof Error ? cause.message : String(cause);
};

/** `unknown` because the CLI framework's own failures also land here. */
export const renderError = (error: unknown): RenderedError => {
  if (ValidationError.isValidationError(error)) {
    return {
      message: 'invalid command line',
      hint: 'run `traces --help`, or `traces <command> --help` for that command',
      code: EXIT_CODES.usage,
      alreadyReported: true,
    };
  }
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
    rendered.alreadyReported === true
      ? `hint: ${rendered.hint}`
      : rendered.hint === undefined
        ? `error: ${rendered.message}`
        : `error: ${rendered.message}\nhint: ${rendered.hint}`,
  );

export class ExitWith extends Schema.TaggedError<ExitWith>()('ExitWith', {
  code: Schema.Number,
}) {}
