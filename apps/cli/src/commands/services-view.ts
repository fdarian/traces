import { Option } from 'effect';
import type { AuthStatus } from '#/auth-status.ts';
import {
  hasLogProvider,
  type LogServiceConfig,
  otelServiceName,
  railwayEnvironmentOf,
  type ServiceConfig,
} from '#/config.ts';
import type { ConfigSource, ResolvedProject } from '#/resolve.ts';
import type { SecretStore } from '#/secrets.ts';
import type { Style } from '#/style.ts';

export type SecretStatus =
  | {
      readonly status: 'present';
      /** Which store answered; the file is read before the keychain. */
      readonly store: SecretStore;
      /** The file holds it and the keychain does too, so the keychain copy is never read. */
      readonly shadowed: boolean;
    }
  | { readonly status: 'missing' }
  | {
      readonly status: 'error';
      readonly detail: string;
      /** The keychain refused without a user to ask (typical over SSH); `--insecure-storage` is the way out. */
      readonly cantPrompt: boolean;
    };

export type HeaderStatus =
  | { readonly name: string; readonly source: 'literal' }
  | {
      readonly name: string;
      readonly source: 'env';
      readonly ref: string;
      readonly status: 'present' | 'missing';
    }
  | ({
      readonly name: string;
      readonly source: 'keychain';
      readonly ref: string;
    } & SecretStatus);

export type TracingCheck =
  | { readonly status: 'reachable'; readonly services: ReadonlyArray<string> }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'error'; readonly detail: string };

export interface TracingStatus {
  readonly provider: 'jaeger';
  readonly url: string;
  readonly headers: ReadonlyArray<HeaderStatus>;
  readonly check: TracingCheck;
}

export interface ServiceEntry {
  readonly service: string;
  /** Absent for trace-only services. */
  readonly provider?: 'vercel' | 'railway';
  readonly ref: ServiceConfig;
  /** The Jaeger service name; set only when the project has tracing or the entry names one. */
  readonly otelService?: string;
  /** Set only when the tracing check reached Jaeger: whether it reports `otelService`. */
  readonly otelInJaeger?: boolean;
}

/** One credential check: a Railway project, or a Vercel team or project. */
export interface ProviderEntry {
  readonly provider: 'railway' | 'vercel';
  readonly scope: string;
  readonly auth: AuthStatus;
}

export type ServicesView = {
  readonly project: string;
  readonly configPath: string;
  readonly configSource: ConfigSource;
  readonly matchedBy: ResolvedProject['matchedBy'];
  /** Home directory, so a terminal can show the config path as `~/...`. Text view only. */
  readonly home: string;
  readonly services: ReadonlyArray<ServiceEntry>;
  readonly providers: ReadonlyArray<ProviderEntry>;
  readonly tracing?: TracingStatus;
  readonly warnings: ReadonlyArray<ServicesWarning>;
};

export type ServicesWarning =
  | {
      readonly kind: 'file-mode';
      readonly path: string;
      /** Octal permission bits, e.g. `0644`. */
      readonly mode: string;
      readonly message: string;
    }
  | {
      readonly kind: 'shadowed';
      readonly name: string;
      readonly path: string;
      readonly message: string;
    };

const OTHERS_BITS = 0o077;

/** The file warning first, then one per secret held by both the file and the keychain, in first-seen order. */
export const servicesWarnings = (input: {
  readonly secretsFile: string;
  readonly fileStatus: Option.Option<{
    readonly path: string;
    readonly mode: number;
  }>;
  readonly headers: ReadonlyArray<HeaderStatus>;
  readonly providers: ReadonlyArray<ProviderEntry>;
}): ReadonlyArray<ServicesWarning> => {
  const warnings: Array<ServicesWarning> = [];
  if (
    Option.isSome(input.fileStatus) &&
    (input.fileStatus.value.mode & OTHERS_BITS) !== 0
  ) {
    const path = input.fileStatus.value.path;
    const mode = input.fileStatus.value.mode.toString(8).padStart(4, '0');
    warnings.push({
      kind: 'file-mode',
      path,
      mode,
      message: `${path} is readable by others (mode ${mode}); run chmod 600 ${path}`,
    });
  }
  const shadowed = new Set<string>([
    ...input.headers.flatMap((header) =>
      header.source === 'keychain' &&
      header.status === 'present' &&
      header.shadowed
        ? [header.ref]
        : [],
    ),
    ...input.providers.flatMap((entry) =>
      entry.auth.shadowedSecret === undefined
        ? []
        : [entry.auth.shadowedSecret],
    ),
  ]);
  for (const name of shadowed) {
    warnings.push({
      kind: 'shadowed',
      name,
      path: input.secretsFile,
      message: `secret "${name}" is in both ${input.secretsFile} and the keychain; the file wins`,
    });
  }
  return warnings;
};

const providerScope = (ref: LogServiceConfig): string =>
  ref.provider === 'vercel' && ref.team !== undefined
    ? `team ${ref.team}`
    : `project ${ref.project}`;

/** One entry per distinct provider scope, in first-seen order. */
export const groupProviders = (
  checks: ReadonlyArray<{
    readonly ref: LogServiceConfig;
    readonly auth: AuthStatus;
  }>,
): ReadonlyArray<ProviderEntry> => {
  const grouped = new Map<string, ProviderEntry>();
  for (const check of checks) {
    const scope = providerScope(check.ref);
    const key = `${check.ref.provider}:${scope}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        provider: check.ref.provider,
        scope,
        auth: check.auth,
      });
    }
  }
  return [...grouped.values()];
};

/** The `--json` document: its shape is the documented contract. */
export const servicesDocument = (view: ServicesView) => ({
  configPath: view.configPath,
  configSource: view.configSource,
  project: view.project,
  matchedBy: view.matchedBy,
  services: view.services,
  providers: view.providers,
  ...(view.tracing === undefined ? {} : { tracing: view.tracing }),
  warnings: view.warnings,
});

type Cell = { readonly plain: string; readonly render: string };

const cell = (plain: string, render: string = plain): Cell => ({
  plain,
  render,
});

const COLUMN_GAP = '  ';

const columnWidths = (rows: ReadonlyArray<ReadonlyArray<Cell>>) => {
  const widths: Array<number> = [];
  for (const row of rows) {
    for (const [index, entry] of row.entries()) {
      const known = widths[index];
      widths[index] =
        known === undefined
          ? entry.plain.length
          : Math.max(known, entry.plain.length);
    }
  }
  return (index: number): number => {
    const width = widths[index];
    if (width === undefined) throw new Error(`no column ${index}`);
    return width;
  };
};

/** Pads on the plain text so ANSI codes never skew the columns; the last cell of a row is left unpadded. */
const align = (rows: ReadonlyArray<ReadonlyArray<Cell>>) => {
  const widthOf = columnWidths(rows);
  const lines = rows.map((row) => {
    const lastFilled = row.reduce(
      (last, entry, index) => (entry.plain === '' ? last : index),
      -1,
    );
    const used = row.slice(0, lastFilled + 1);
    return used
      .map((entry, index) =>
        index === used.length - 1
          ? entry.render
          : entry.render + ' '.repeat(widthOf(index) - entry.plain.length),
      )
      .join(COLUMN_GAP);
  });
  return { lines, widthOf };
};

const SECTION_INDENT = '  ';

const shortenHome = (path: string, home: string): string =>
  path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

const PROJECT_HEADER = 'PROJECT';

const describeMatch = (view: ServicesView): string => {
  if (view.configSource === 'repo') return 'repo traces.json';
  const source = view.configSource === 'global' ? 'global' : '--config';
  switch (view.matchedBy) {
    case 'flag':
      return `${source}, picked by --project`;
    case 'path':
      return `${source}, matched by path`;
    case 'git':
      return `${source}, matched by git remote`;
    case 'repo':
      throw new Error(
        `matchedBy "repo" with config source "${view.configSource}"`,
      );
  }
};

const environmentOf = (ref: LogServiceConfig): string =>
  ref.provider === 'railway' ? railwayEnvironmentOf(ref) : '';

const PROJECT_ID_PREFIX = 8;

const railwayProjectOf = (ref: LogServiceConfig, terminal: boolean): string => {
  if (ref.provider !== 'railway') return '';
  return terminal ? ref.project.slice(0, PROJECT_ID_PREFIX) : ref.project;
};

const servicesSection = (
  view: ServicesView,
  style: Style,
  terminal: boolean,
): string => {
  const reported =
    view.tracing?.check.status === 'reachable'
      ? view.tracing.check.services
      : undefined;
  const logRefs = view.services.flatMap((record) =>
    hasLogProvider(record.ref) ? [record.ref] : [],
  );
  const railwayProjects = new Set(
    logRefs.flatMap((ref) => (ref.provider === 'railway' ? [ref.project] : [])),
  );
  const showProject = railwayProjects.size > 1;
  const envWidth = Math.max(
    0,
    ...logRefs.map((ref) => environmentOf(ref).length),
  );
  const widths = {
    provider: Math.max(
      'PROVIDER'.length,
      ...logRefs.map((ref) => ref.provider.length),
    ),
    project: Math.max(
      PROJECT_HEADER.length,
      ...logRefs.map((ref) => railwayProjectOf(ref, terminal).length),
    ),
  };

  /** PROVIDER, PROJECT and ENV share one cell so a trace-only row can span them. */
  const targetOf = (
    provider: string,
    project: string,
    environment: string,
  ): string =>
    [
      provider.padEnd(widths.provider),
      ...(showProject ? [project.padEnd(widths.project)] : []),
      ...(envWidth === 0 ? [] : [environment]),
    ]
      .join(COLUMN_GAP)
      .trimEnd();

  const target = (record: ServiceEntry): Cell => {
    if (!hasLogProvider(record.ref)) return cell('traces only');
    return cell(
      targetOf(
        record.ref.provider,
        railwayProjectOf(record.ref, terminal),
        environmentOf(record.ref),
      ),
    );
  };

  const traces = (record: ServiceEntry): Cell | undefined => {
    if (reported === undefined) return undefined;
    const otel = otelServiceName(record.service, record.ref);
    if (!reported.includes(otel)) {
      const text = '– no spans';
      return cell(text, style.dim(text));
    }
    const alias = otel === record.service ? '' : ` ${otel}`;
    return cell(`✓${alias}`, `${style.green('✓')}${alias}`);
  };

  const headerCell = (text: string): Cell => cell(text, style.dim(text));
  const headerRow = [
    headerCell('SERVICE'),
    headerCell(targetOf('PROVIDER', PROJECT_HEADER, 'ENV')),
    ...(reported === undefined ? [] : [headerCell('TRACES')]),
  ];

  const rows = view.services.map((record) => {
    const row = [cell(record.service), target(record)];
    const tracesCell = traces(record);
    return tracesCell === undefined ? row : [...row, tracesCell];
  });
  return [
    style.bold('Services'),
    ...align([headerRow, ...rows]).lines.map(
      (line) => `${SECTION_INDENT}${line}`,
    ),
  ].join('\n');
};

type ProviderLine = {
  readonly cells: ReadonlyArray<Cell>;
  readonly extra: ReadonlyArray<string>;
};

const authLine = (
  name: 'railway' | 'vercel',
  scope: string,
  auth: AuthStatus,
  style: Style,
): ProviderLine => {
  if (auth.status === 'ok') {
    return {
      cells: [
        cell(name),
        cell(scope),
        cell(`✓ ${auth.detail}`, `${style.green('✓')} ${auth.detail}`),
      ],
      extra: [],
    };
  }
  const status = `✗ ${auth.status}`;
  return {
    cells: [cell(name), cell(scope), cell(status, style.red(status))],
    extra: [auth.detail],
  };
};

const accountLines = (view: ServicesView, style: Style) =>
  view.providers.map((entry) =>
    authLine(entry.provider, entry.scope, entry.auth, style),
  );

const describeHeader = (header: HeaderStatus, style: Style) => {
  if (header.source === 'literal') {
    return { part: cell(`${header.name} literal`), hint: undefined };
  }
  if (header.status === 'present') {
    const store = header.source === 'keychain' ? header.store : 'env';
    return {
      part: cell(`${header.name} from ${store} ${header.ref}`),
      hint: undefined,
    };
  }
  const where = `${header.source} ${header.ref}`;
  const state =
    header.status === 'error' ? `error (${header.detail})` : 'missing';
  const text = `✗ ${header.name}: ${where} ${state}`;
  return {
    part: cell(text, style.red(text)),
    hint: keychainHint(header),
  };
};

const keychainHint = (header: HeaderStatus): string | undefined => {
  if (header.source !== 'keychain') return undefined;
  if (header.status === 'missing')
    return `hint: traces secret set ${header.ref}`;
  if (header.status === 'error' && header.cantPrompt) {
    return `hint: traces secret set ${header.ref} --insecure-storage`;
  }
  return undefined;
};

const checkPart = (check: TracingCheck, style: Style): Cell => {
  if (check.status === 'reachable') {
    return cell('✓ reachable', `${style.green('✓')} reachable`);
  }
  const text = `✗ ${check.status}`;
  return cell(text, style.red(text));
};

const jaegerLine = (
  tracing: TracingStatus,
  view: ServicesView,
  style: Style,
) => {
  const headers = tracing.headers.map((header) =>
    describeHeader(header, style),
  );
  const blocked = tracing.headers.some(
    (header) => header.source !== 'literal' && header.status !== 'present',
  );
  // A missing or unreadable secret is why the check errored; the header part already says so.
  const check =
    blocked && tracing.check.status === 'error'
      ? []
      : [checkPart(tracing.check, style)];
  const parts = [...check, ...headers.map((entry) => entry.part)];
  const status = cell(
    parts.map((part) => part.plain).join(', '),
    parts.map((part) => part.render).join(', '),
  );
  const extra = [
    ...(tracing.check.status === 'error' && !blocked
      ? [tracing.check.detail]
      : []),
    ...headers.flatMap((entry) =>
      entry.hint === undefined ? [] : [entry.hint],
    ),
  ];
  if (tracing.check.status === 'reachable') {
    const mapped = new Set(
      view.services.map((record) =>
        otelServiceName(record.service, record.ref),
      ),
    );
    const unmapped = tracing.check.services.filter(
      (service) => !mapped.has(service),
    );
    if (tracing.check.services.length === 0) {
      extra.push(style.dim('no services reporting yet'));
    } else if (unmapped.length > 0) {
      extra.push(
        style.dim(`also reporting, not in config: ${unmapped.join(', ')}`),
      );
    }
  }
  return {
    cells: [cell('jaeger'), cell(tracing.url), status],
    extra,
  } satisfies ProviderLine;
};

const providersSection = (view: ServicesView, style: Style) => {
  const lines = [
    ...accountLines(view, style),
    ...(view.tracing === undefined
      ? []
      : [jaegerLine(view.tracing, view, style)]),
  ];
  if (lines.length === 0) return undefined;
  const aligned = align(lines.map((line) => line.cells));
  const continuation = `${SECTION_INDENT}${' '.repeat(aligned.widthOf(0) + COLUMN_GAP.length)}`;
  return [
    style.bold('Providers'),
    ...lines.flatMap((line, index) => [
      `${SECTION_INDENT}${aligned.lines[index]}`,
      ...line.extra.map((text) => `${continuation}${text}`),
    ]),
  ].join('\n');
};

const warningsSection = (view: ServicesView, style: Style) =>
  view.warnings.length === 0
    ? undefined
    : view.warnings
        .map((warning) => `${style.yellow('warning:')} ${warning.message}`)
        .join('\n');

export const renderServices = (
  view: ServicesView,
  style: Style,
  terminal: boolean,
): string => {
  const configPath = terminal
    ? shortenHome(view.configPath, view.home)
    : view.configPath;
  const header = `${style.bold(view.project)}  ${style.dim(`${configPath} (${describeMatch(view)})`)}`;
  return [
    header,
    servicesSection(view, style, terminal),
    providersSection(view, style),
    warningsSection(view, style),
  ]
    .filter((section) => section !== undefined)
    .join('\n\n');
};
