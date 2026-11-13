import type { AuthStatus } from '#/auth-status.ts';
import {
  hasLogProvider,
  otelServiceName,
  type ServiceConfig,
} from '#/config.ts';
import type { ConfigSource, ResolvedProject } from '#/resolve.ts';
import type { Style } from '#/style.ts';

export type SecretStatus =
  | { readonly status: 'present' | 'missing' }
  | { readonly status: 'error'; readonly detail: string };

export type HeaderStatus =
  | { readonly name: string; readonly source: 'literal' }
  | ({
      readonly name: string;
      readonly source: 'env' | 'keychain';
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

/** The NDJSON record: its shape is the documented `--json` contract. */
export interface ServiceRecord {
  readonly configPath: string;
  readonly configSource: ConfigSource;
  readonly project: string;
  readonly matchedBy: ResolvedProject['matchedBy'];
  readonly service: string;
  /** Absent for trace-only services. */
  readonly provider?: 'vercel' | 'railway';
  readonly ref: ServiceConfig;
  /** Absent for trace-only services. */
  readonly auth?: AuthStatus;
  /** The Jaeger service name; set only when the project has tracing or the entry names one. */
  readonly otelService?: string;
  /** Set only when the tracing check reached Jaeger: whether it reports `otelService`. */
  readonly otelInJaeger?: boolean;
  readonly tracing?: TracingStatus;
}

export type ServicesView = {
  readonly project: string;
  readonly configPath: string;
  readonly configSource: ConfigSource;
  readonly matchedBy: ResolvedProject['matchedBy'];
  /** Home directory, so the config path can be shown as `~/...`. */
  readonly home: string;
  readonly tracing?: TracingStatus;
  readonly records: ReadonlyArray<ServiceRecord>;
};

type Cell = { readonly plain: string; readonly render: string };

const cell = (plain: string, render: string = plain): Cell => ({
  plain,
  render,
});

const COLUMN_GAP = '  ';

/** Pads on the plain text so ANSI codes never skew the columns; the last cell of a row is left unpadded. */
const align = (rows: ReadonlyArray<ReadonlyArray<Cell>>) => {
  const widths: Array<number> = [];
  for (const row of rows) {
    row.forEach((entry, index) => {
      widths[index] = Math.max(widths[index] ?? 0, entry.plain.length);
    });
  }
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
          : entry.render +
            ' '.repeat((widths[index] ?? 0) - entry.plain.length),
      )
      .join(COLUMN_GAP);
  });
  return { lines, widths };
};

const SECTION_INDENT = '  ';

const shortenHome = (path: string, home: string): string =>
  path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

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

const environmentOf = (record: ServiceRecord): string =>
  hasLogProvider(record.ref) && record.ref.provider === 'railway'
    ? (record.ref.environment ?? 'production')
    : '';

const servicesSection = (view: ServicesView, style: Style): string => {
  const reported =
    view.tracing?.check.status === 'reachable'
      ? view.tracing.check.services
      : undefined;
  const logRows = view.records.filter((record) => hasLogProvider(record.ref));
  const providerWidth = Math.max(
    0,
    ...logRows.map((record) => record.provider?.length ?? 0),
  );
  const envWidth = Math.max(0, ...logRows.map((r) => environmentOf(r).length));

  const target = (record: ServiceRecord): Cell => {
    if (!hasLogProvider(record.ref) || record.provider === undefined) {
      return cell('traces only');
    }
    const provider = record.provider.padEnd(providerWidth);
    return cell(
      envWidth === 0
        ? provider.trimEnd()
        : `${provider}${COLUMN_GAP}${environmentOf(record)}`.trimEnd(),
    );
  };

  const traces = (record: ServiceRecord): Cell | undefined => {
    if (reported === undefined) return undefined;
    const otel = otelServiceName(record.service, record.ref);
    if (!reported.includes(otel)) {
      const text = 'traces – not reporting';
      return cell(text, style.dim(text));
    }
    const alias = otel === record.service ? '' : ` as ${otel}`;
    return cell(`traces ✓${alias}`, `traces ${style.green('✓')}${alias}`);
  };

  const rows = view.records.map((record) => {
    const row = [cell(record.service), target(record)];
    const tracesCell = traces(record);
    return tracesCell === undefined ? row : [...row, tracesCell];
  });
  return [
    style.bold('Services'),
    ...align(rows).lines.map((line) => `${SECTION_INDENT}${line}`),
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

const accountLines = (view: ServicesView, style: Style) => {
  const seen = new Set<string>();
  const lines: Array<ProviderLine> = [];
  for (const record of view.records) {
    if (
      !hasLogProvider(record.ref) ||
      record.provider === undefined ||
      record.auth === undefined
    ) {
      continue;
    }
    const ref = record.ref;
    const scope =
      ref.provider === 'railway'
        ? `project ${ref.project}`
        : ref.team === undefined
          ? `project ${ref.project}`
          : `team ${ref.team}`;
    const key = `${ref.provider}:${scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(authLine(record.provider, scope, record.auth, style));
  }
  return lines;
};

const describeHeader = (header: HeaderStatus, style: Style) => {
  if (header.source === 'literal') {
    return { part: cell(`${header.name} literal`), hint: undefined };
  }
  const where = `${header.source} ${header.ref}`;
  if (header.status === 'present') {
    return { part: cell(`${header.name} from ${where}`), hint: undefined };
  }
  const state =
    header.status === 'error' ? `error (${header.detail})` : 'missing';
  const text = `✗ ${header.name}: ${where} ${state}`;
  return {
    part: cell(text, style.red(text)),
    hint:
      header.source === 'keychain' && header.status === 'missing'
        ? `hint: traces secret set ${header.ref}`
        : undefined,
  };
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
      view.records.map((record) => otelServiceName(record.service, record.ref)),
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
  const continuation = `${SECTION_INDENT}${' '.repeat((aligned.widths[0] ?? 0) + COLUMN_GAP.length)}`;
  return [
    style.bold('Providers'),
    ...lines.flatMap((line, index) => [
      `${SECTION_INDENT}${aligned.lines[index]}`,
      ...line.extra.map((text) => `${continuation}${text}`),
    ]),
  ].join('\n');
};

export const renderServices = (view: ServicesView, style: Style): string => {
  const header = `${style.bold(view.project)}  ${style.dim(`${shortenHome(view.configPath, view.home)} (${describeMatch(view)})`)}`;
  return [header, servicesSection(view, style), providersSection(view, style)]
    .filter((section) => section !== undefined)
    .join('\n\n');
};
