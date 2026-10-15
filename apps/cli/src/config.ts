import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, Effect, Option, Schema } from 'effect';
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

/** A literal, `{ env }` (read at use time) or `{ keychain }` (read from the OS keychain at use time). */
const HeaderValue = Schema.Union([
  NonEmpty,
  Schema.Struct({ env: NonEmpty }),
  Schema.Struct({ keychain: NonEmpty }),
]);

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

const ProjectConfig = Schema.Struct({
  matcher: Matcher,
  tracing: Schema.optional(TracingConfig),
  services: Schema.Record(Identifier, ServiceConfig).check(
    Schema.makeFilter((services) => Object.keys(services).length > 0, {
      message: 'a project needs at least one service',
    }),
  ),
});

export const TracesConfigSchema = Schema.Struct({
  projects: Schema.Record(Identifier, ProjectConfig),
});

export type TracesConfig = typeof TracesConfigSchema.Type;
export type ProjectConfig = typeof ProjectConfig.Type;
export type ServiceConfig = typeof ServiceConfig.Type;
export type TracingConfig = typeof TracingConfig.Type;
export type HeaderValue = typeof HeaderValue.Type;
export type LogServiceConfig = Exclude<
  ServiceConfig,
  typeof TraceOnlyService.Type
>;

export const hasLogProvider = (
  config: ServiceConfig,
): config is LogServiceConfig => 'provider' in config;

export const otelServiceName = (name: string, config: ServiceConfig) =>
  config.otelService ?? name;
export type ProjectMatcher = typeof Matcher.Type;

const ConfigJson = Schema.fromJsonString(TracesConfigSchema);

export const defaultConfigPath = (home: string, xdgConfigHome?: string) =>
  join(xdgConfigHome ?? join(home, '.config'), 'traces', 'config.json');

export const resolveDefaultConfigPath = Effect.gen(function* () {
  const xdg = yield* Config.String('XDG_CONFIG_HOME').pipe(Config.option);
  return defaultConfigPath(homedir(), Option.getOrUndefined(xdg));
});

const CONFIG_HINT =
  'create the file; `traces --help` shows a minimal example for each provider';

export const decodeConfig = (path: string, content: string) =>
  Schema.decodeUnknownEffect(ConfigJson, { onExcessProperty: 'error' })(
    content,
  ).pipe(
    Effect.mapError(
      (error) =>
        new ConfigError({
          path,
          message: error.message,
          hint: CONFIG_HINT,
        }),
    ),
  );

export const readConfig = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const content = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            path,
            message:
              error.reason._tag === 'NotFound'
                ? 'config file not found'
                : `cannot read config file: ${error.message}`,
            hint: CONFIG_HINT,
          }),
      ),
    );
    return yield* decodeConfig(path, content);
  });
