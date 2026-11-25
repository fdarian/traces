import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, Effect, Option, Schema, type SchemaIssue } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { ConfigError } from '#/errors.ts';

const Identifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, {
    message:
      'expected a non-empty name containing only letters, numbers, `_`, or `-`',
  }),
);

const NonEmpty = Schema.NonEmptyString;

const OtelService = { otelService: Schema.optional(NonEmpty) };

const VercelService = Schema.Struct({
  provider: Schema.Literal('vercel'),
  project: NonEmpty,
  team: Schema.optional(NonEmpty),
  ...OtelService,
});

const RailwayService = Schema.Struct({
  provider: Schema.Literal('railway'),
  project: NonEmpty,
  service: NonEmpty,
  environment: Schema.optional(NonEmpty),
  ...OtelService,
});

/** No `provider`: logs and deploys reject it, only the trace commands use it. */
const TraceOnlyService = Schema.Struct({ otelService: NonEmpty });

const ServiceConfig = Schema.Union([
  VercelService,
  RailwayService,
  TraceOnlyService,
]);

const isAbsoluteHttpUrl = (value: string) => {
  if (!URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
};

const AbsoluteHttpUrl = NonEmpty.check(
  Schema.makeFilter(isAbsoluteHttpUrl, {
    message:
      'expected an absolute http(s) URL, e.g. https://jaeger.example.com',
  }),
);

const HeaderName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, {
    message: 'expected a valid HTTP header name',
  }),
);

/** `{ env }` or `{ keychain }`, both read at use time. */
const SecretRef = Schema.Union([
  Schema.Struct({ env: NonEmpty }),
  Schema.Struct({ keychain: NonEmpty }),
]);

/** A token the CLI sends to Railway's API, or `cli` to borrow the logged-in `railway` binary. */
const RailwayAuth = Schema.Union([SecretRef, Schema.Literal('cli')]);

/** A literal or a `SecretRef`. */
const HeaderValue = Schema.Union([NonEmpty, SecretRef]);

const TracingConfig = Schema.Struct({
  provider: Schema.Literal('jaeger'),
  url: AbsoluteHttpUrl,
  headers: Schema.optional(Schema.Record(HeaderName, HeaderValue)),
});

const ProjectPath = NonEmpty.check(
  Schema.makeFilter((path) => path.startsWith('/') || path.startsWith('~/'), {
    message: 'path matchers must be absolute or begin with `~/`',
  }),
);

const Matcher = Schema.Union([
  Schema.Struct({ type: Schema.Literal('path'), path: ProjectPath }),
  Schema.Struct({ type: Schema.Literal('git'), repo: NonEmpty }),
]);

const projectFields = {
  tracing: Schema.optional(TracingConfig),
  /** Optional at decode time: it is required only when a Railway service is actually used. */
  railway: Schema.optional(Schema.Struct({ auth: RailwayAuth })),
  services: Schema.Record(Identifier, ServiceConfig).check(
    Schema.makeFilter((services) => Object.keys(services).length > 0, {
      message: 'a project needs at least one service',
    }),
  ),
};

/** What commands read from a project; the global config adds a matcher on top, the repo file does not need one. */
const ProjectSettings = Schema.Struct(projectFields);

const ProjectConfig = Schema.Struct({ matcher: Matcher, ...projectFields });

export const RepoConfigSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  name: Schema.optional(Identifier),
  ...projectFields,
});

export const TracesConfigSchema = Schema.Struct({
  projects: Schema.Record(Identifier, ProjectConfig),
});

export type TracesConfig = typeof TracesConfigSchema.Type;
export type ProjectConfig = typeof ProjectConfig.Type;
export type ProjectSettings = typeof ProjectSettings.Type;
export type RepoConfig = typeof RepoConfigSchema.Type;
export type ServiceConfig = typeof ServiceConfig.Type;
export type TracingConfig = typeof TracingConfig.Type;
export type HeaderValue = typeof HeaderValue.Type;
export type SecretRef = typeof SecretRef.Type;
export type RailwayAuth = typeof RailwayAuth.Type;
export type LogServiceConfig = Exclude<
  ServiceConfig,
  typeof TraceOnlyService.Type
>;

export type RailwayServiceConfig = Extract<
  ServiceConfig,
  { provider: 'railway' }
>;

/** Railway's own default, used when the config entry names no environment. */
export const railwayEnvironmentOf = (config: RailwayServiceConfig): string =>
  config.environment ?? 'production';

export const hasLogProvider = (
  config: ServiceConfig,
): config is LogServiceConfig => 'provider' in config;

export const otelServiceName = (name: string, config: ServiceConfig) =>
  config.otelService ?? name;
export type ProjectMatcher = typeof Matcher.Type;

const ConfigJson = Schema.fromJsonString(TracesConfigSchema);
const RepoConfigJson = Schema.fromJsonString(RepoConfigSchema);

export const defaultConfigDir = (home: string, xdgConfigHome?: string) =>
  join(xdgConfigHome ?? join(home, '.config'), 'traces');

export const defaultConfigPath = (home: string, xdgConfigHome?: string) =>
  join(defaultConfigDir(home, xdgConfigHome), 'config.json');

export const resolveDefaultConfigDir = Effect.gen(function* () {
  const xdg = yield* Config.String('XDG_CONFIG_HOME').pipe(Config.option);
  return defaultConfigDir(homedir(), Option.getOrUndefined(xdg));
});

export const resolveDefaultConfigPath = resolveDefaultConfigDir.pipe(
  Effect.map((dir) => join(dir, 'config.json')),
);

const EXAMPLE_HINT =
  '`traces skills get core --file references/config.md` shows a minimal example for each provider';

const createFileHint = (path: string) =>
  `run \`traces init\` in the repo to write traces.json, or create ${path}; ${EXAMPLE_HINT}`;

const issuePath = (issue: SchemaIssue.Issue): ReadonlyArray<PropertyKey> => {
  switch (issue._tag) {
    case 'Pointer':
      return [...issue.path, ...issuePath(issue.issue)];
    case 'Filter':
    case 'Encoding':
      return issuePath(issue.issue);
    case 'Composite':
    case 'AnyOf': {
      const first = issue.issues[0];
      return first === undefined ? [] : issuePath(first);
    }
    default:
      return [];
  }
};

const invalidConfigHint = (issue: SchemaIssue.Issue) => {
  const path = issuePath(issue);
  return path.length === 0
    ? `fix the file's JSON syntax; ${EXAMPLE_HINT}`
    : `fix \`${path.map(String).join('.')}\` in the file; ${EXAMPLE_HINT}`;
};

const decodeWith =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (path: string, content: string) =>
    Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(
      content,
    ).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            path,
            message: error.message,
            hint: invalidConfigHint(error.issue),
          }),
      ),
    );

export const decodeConfig = decodeWith(ConfigJson);

export const decodeRepoConfig = decodeWith(RepoConfigJson);

const readConfigFile = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    return yield* fileSystem.readFileString(path);
  });

export const readConfig = (path: string) =>
  readConfigFile(path).pipe(
    Effect.mapError(
      (error) =>
        new ConfigError({
          path,
          message:
            error.reason._tag === 'NotFound'
              ? 'config file not found'
              : `cannot read config file: ${error.message}`,
          hint:
            error.reason._tag === 'NotFound'
              ? createFileHint(path)
              : 'check the file permissions',
        }),
    ),
    Effect.flatMap((content) => decodeConfig(path, content)),
  );

/** `None` when no file exists at `path`; any other read or decode failure is an error. */
export const readRepoConfig = (path: string) =>
  readConfigFile(path).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (error) => error.reason._tag === 'NotFound',
      () => Effect.succeed(Option.none<string>()),
    ),
    Effect.mapError(
      (error) =>
        new ConfigError({
          path,
          message: `cannot read config file: ${error.message}`,
          hint: 'check the file permissions',
        }),
    ),
    Effect.flatMap((content) =>
      Option.isNone(content)
        ? Effect.succeed(Option.none<RepoConfig>())
        : decodeRepoConfig(path, content.value).pipe(Effect.map(Option.some)),
    ),
  );
