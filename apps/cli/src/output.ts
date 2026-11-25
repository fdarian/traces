import {
  type Deployment,
  firstLine,
  InvalidCursor,
  JaegerBadResponse,
  JaegerUnreachable,
  type LogRecord,
  NoReadyDeployment,
  type Provider,
  ProviderAuthError,
  ProviderNotFound,
  ProviderRequestError,
  ProviderResponseInvalid,
  ProviderToolMissing,
  type SpanRow,
  TraceBackendUnauthorized,
  TraceNotFound,
  type TraceRow,
} from '@traces/core';
import {
  Cause,
  Console,
  Effect,
  Exit,
  Option,
  Schema,
  SchemaIssue,
} from 'effect';
import { CliError, CliOutput } from 'effect/cli';
import {
  ConflictingFlags,
  FileNotFound,
  InvalidPath,
  InvalidSkill,
  SkillNotFound,
} from 'effect-cli-skills';
import {
  ConfigError,
  EnvVarMissing,
  NothingDiscovered,
  RailwayProjectLookupFailed,
  UsageError,
} from '#/errors.ts';
import { SHORTEST_RETENTION_MS } from '#/limits.ts';
import { SecretMissing, SecretStoreError } from '#/secrets.ts';

export type OutputMode = 'text' | 'json';

export const outputMode = (jsonFlag: boolean): OutputMode =>
  jsonFlag ? 'json' : 'text';

/**
 * Read once per command and passed to the text formatters, which shorten
 * values only for a terminal: piped text must carry full ids.
 */
export const stdoutIsTerminal = (): boolean => process.stdout.isTTY === true;

/** Stderr lines follow the same rule as stdout, but a stream can be piped independently of the other. */
export const stderrIsTerminal = (): boolean => process.stderr.isTTY === true;

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

/** The 8-char prefix is for a terminal only; a pipe gets the id an agent can paste into the next command. */
export const displayId = (id: string, terminal: boolean): string =>
  terminal ? shortId(id) : id;

export const formatLogLine = (
  record: LogRecord,
  withDate: boolean,
  terminal: boolean,
): string => {
  const trace =
    record.traceId === undefined
      ? ''
      : ` trace=${displayId(record.traceId, terminal)}`;
  const lines = record.message.split('\n');
  const head = `${formatTime(record.ts, withDate)} ${record.level.toUpperCase().padEnd(5)} ${record.service}${trace} ${lines.slice(0, 1).join('')}`;
  return [head, ...lines.slice(1).map((line) => `    ${line}`)].join('\n');
};

/**
 * The `deploy <id>` line that precedes the first log line of a deployment. A record without a
 * deployment id never opens a new block: its line stays under the last header printed.
 */
export const deploymentHeader = (
  record: LogRecord,
  printed: string | undefined,
  terminal: boolean,
): string | undefined =>
  record.deploymentId === undefined || record.deploymentId === printed
    ? undefined
    : `deploy ${displayId(record.deploymentId, terminal)}`;

export const formatTraceLine = (
  row: TraceRow,
  withDate: boolean,
  terminal: boolean,
): string => {
  const errors = row.errorSpanCount === 0 ? '' : ` ERR×${row.errorSpanCount}`;
  const id = terminal ? `${shortId(row.traceId)}…` : row.traceId;
  return `${formatTime(row.startTs, withDate)} ${row.durationMs}ms${errors} ${row.rootService} ${row.rootOperation}  ${id}`;
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
      ...(exception?.stacktrace === undefined
        ? []
        : topFrames(exception.stacktrace)
      ).map((frame) => `${gutter}${indent}    ${frame}`),
    ];
  });
};

/** 7 characters is for a terminal only; a pipe gets the full sha an agent compares with `git rev-parse HEAD`. */
const displaySha = (sha: string, terminal: boolean): string =>
  terminal ? sha.slice(0, 7) : sha;

export const formatDeploymentLine = (
  deployment: Deployment,
  terminal: boolean,
): string => {
  const commit = deployment.commit;
  const sha = commit === undefined ? '-' : displaySha(commit.sha, terminal);
  const branch = commit?.branch ?? '-';
  const message = commit?.message?.split('\n')[0] ?? '';
  const url = deployment.url === undefined ? '' : ` ${deployment.url}`;
  return `${deployment.status.padEnd(9)} ${displayId(deployment.id, terminal)} ${sha} ${branch} ${formatTime(deployment.createdAt, true)} ${message}${url}`.trimEnd();
};

export const emitRecord = <A>(
  mode: OutputMode,
  record: A,
  text: (record: A) => string,
) => Console.log(mode === 'json' ? JSON.stringify(record) : text(record));

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

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** A non-empty path means the top-level shape matched and a nested field didn't; a body that isn't JSON or isn't an object fails at the root. */
const failsBelowRoot = (cause: unknown): boolean =>
  Schema.isSchemaError(cause) &&
  formatIssues(cause.issue).issues.some(
    (issue) => issue.path !== undefined && issue.path.length > 0,
  );

const badResponseHint = (error: JaegerBadResponse): string => {
  if (error.status >= 300 && error.status < 400) {
    return 'the URL redirects; use the final URL as tracing.url';
  }
  if (
    error.status >= 200 &&
    error.status < 300 &&
    failsBelowRoot(error.cause)
  ) {
    return "the backend answered like Jaeger /api/v3 but a field didn't match what traces expects; likely a traces bug, please report it with the error above";
  }
  const servesHtml =
    /html/i.test(error.contentType ?? '') ||
    /^<(!doctype|html)/i.test(error.body);
  return servesHtml
    ? 'the URL serves a web page, not the Jaeger API; point `tracing.url` at the Jaeger query host'
    : 'the URL may not point at a Jaeger v2 query service (/api/v3)';
};

/** `unknown` because the CLI framework's own failures also land here. */
export const renderError = (error: unknown): RenderedError => {
  if (CliError.isCliError(error)) return renderCliError(error);
  if (error instanceof UsageError) {
    return { message: error.message, hint: error.hint, code: EXIT_CODES.usage };
  }
  if (
    error instanceof SkillNotFound ||
    error instanceof FileNotFound ||
    error instanceof InvalidPath ||
    error instanceof ConflictingFlags
  ) {
    return { message: error.message, hint: error.hint, code: EXIT_CODES.usage };
  }
  // A shipped skill that breaks the layout is a bug in traces, not in the invocation.
  if (error instanceof InvalidSkill) {
    return {
      message: error.message,
      hint: error.hint,
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof ConfigError) {
    return {
      message: `${error.path}: ${error.message}`,
      hint: error.hint,
      code: EXIT_CODES.usage,
    };
  }
  if (error instanceof RailwayProjectLookupFailed) {
    const inner = renderError(error.cause);
    return {
      message: `Railway project ${error.project}: ${inner.message}`,
      ...(inner.hint === undefined ? {} : { hint: inner.hint }),
      code: inner.code,
    };
  }
  if (error instanceof ProviderAuthError) {
    return {
      message: `${error.provider}: not authorized`,
      hint: error.hint,
      code: EXIT_CODES.auth,
    };
  }
  if (error instanceof NothingDiscovered) {
    return {
      message: 'found no Railway or Vercel project to put in traces.json',
      hint: 'link the folder with `railway link` / `vercel link`, or pass --railway-project',
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof NoReadyDeployment) {
    return {
      message: `${error.service} has no ready deployment among its last ${error.scanned}`,
      hint: `traces deploys ${error.service}`,
      code: EXIT_CODES.runtime,
    };
  }
  if (error instanceof ProviderToolMissing) {
    return {
      message: `${error.provider}: ${error.tool} not found`,
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
    const received =
      error.contentType === undefined
        ? `HTTP ${error.status}`
        : `HTTP ${error.status}, ${singleLine(error.contentType)}`;
    const body = singleLine(error.body);
    return {
      message: `tracing backend returned an unexpected response (${received}): ${causeMessage(error.cause)}; body: ${body === '' ? '(empty)' : `"${body}"`}`,
      hint: badResponseHint(error),
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

const formatError = (rendered: RenderedError): string =>
  rendered.hint === undefined
    ? `error: ${rendered.message}`
    : `error: ${rendered.message}\nhint: ${rendered.hint}`;

export const reportError = (rendered: RenderedError) =>
  Console.error(formatError(rendered));

export class ExitWith extends Schema.TaggedError<ExitWith>()('ExitWith', {
  code: Schema.Number,
}) {}

export interface ExitReport {
  readonly code: number;
  readonly stderr?: string;
}

/**
 * Typed failures were already reported before they became `ExitWith`; whatever
 * else ends the run is a defect that nothing reported, so it is printed here.
 */
export const exitReport = (
  exit: Exit.Exit<unknown, unknown>,
  debug: boolean,
): ExitReport => {
  if (Exit.isSuccess(exit)) return { code: EXIT_CODES.ok };
  if (Cause.hasInterruptsOnly(exit.cause)) return { code: 130 };
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof ExitWith) {
    return { code: failure.value.code };
  }
  const message = formatError({
    message: singleLine(causeMessage(Cause.squash(exit.cause))),
    hint: 'this is a bug in traces; rerun with TRACES_DEBUG=1 for the stack',
    code: EXIT_CODES.runtime,
  });
  return {
    code: EXIT_CODES.runtime,
    stderr: debug ? `${message}\n${Cause.pretty(exit.cause)}` : message,
  };
};

/**
 * The framework prints the full usage block before failing a parse. The
 * failure surfaces instead as the one-line `error:` + `hint:` that `main.ts`
 * renders from the `ShowHelp` error, so the block is dropped here.
 */
export const parseErrorPresenter: CliOutput.Presenter = {
  present: (event) =>
    event._tag === 'InvalidInvocation'
      ? Effect.void
      : CliOutput.defaultPresenter.present(event),
};
