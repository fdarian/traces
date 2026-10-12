import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileSystem } from '@effect/platform';
import { Config, Effect, Option, ParseResult, Schema } from 'effect';
import { ConfigError } from '#/errors.ts';

const Identifier = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]+$/, {
    message: () =>
      'expected a non-empty name containing only letters, numbers, `_`, or `-`',
  }),
);

const NonEmpty = Schema.NonEmptyString;

const VercelService = Schema.Struct({
  provider: Schema.Literal('vercel'),
  project: NonEmpty,
  team: Schema.optional(NonEmpty),
});

const RailwayService = Schema.Struct({
  provider: Schema.Literal('railway'),
  project: NonEmpty,
  service: NonEmpty,
  environment: Schema.optional(NonEmpty),
});

const ServiceConfig = Schema.Union(VercelService, RailwayService);

const ProjectPath = NonEmpty.pipe(
  Schema.filter((path) => path.startsWith('/') || path.startsWith('~/'), {
    message: () => 'path matchers must be absolute or begin with `~/`',
  }),
);

const Matcher = Schema.Union(
  Schema.Struct({ type: Schema.Literal('path'), path: ProjectPath }),
  Schema.Struct({ type: Schema.Literal('git'), repo: NonEmpty }),
);

const ProjectConfig = Schema.Struct({
  matcher: Matcher,
  services: Schema.Record({ key: Identifier, value: ServiceConfig }).pipe(
    Schema.filter((services) => Object.keys(services).length > 0, {
      message: () => 'a project needs at least one service',
    }),
  ),
});

export const TracesConfigSchema = Schema.Struct({
  projects: Schema.Record({ key: Identifier, value: ProjectConfig }),
});

export type TracesConfig = typeof TracesConfigSchema.Type;
export type ProjectConfig = typeof ProjectConfig.Type;
export type ServiceConfig = typeof ServiceConfig.Type;
export type ProjectMatcher = typeof Matcher.Type;

const ConfigJson = Schema.parseJson(TracesConfigSchema);

export const defaultConfigPath = (home: string, xdgConfigHome?: string) =>
  join(xdgConfigHome ?? join(home, '.config'), 'traces', 'config.json');

export const resolveDefaultConfigPath = Effect.gen(function* () {
  const xdg = yield* Config.string('XDG_CONFIG_HOME').pipe(Config.option);
  return defaultConfigPath(homedir(), Option.getOrUndefined(xdg));
});

const CONFIG_HINT =
  'create the file; `traces --help` shows a minimal example for each provider';

export const decodeConfig = (path: string, content: string) =>
  Schema.decodeUnknown(ConfigJson, { onExcessProperty: 'error' })(content).pipe(
    Effect.mapError(
      (error) =>
        new ConfigError({
          path,
          message: ParseResult.TreeFormatter.formatErrorSync(error),
          hint: CONFIG_HINT,
        }),
    ),
  );

export const readConfig = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const content = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            path,
            message:
              error._tag === 'SystemError' && error.reason === 'NotFound'
                ? 'config file not found'
                : `cannot read config file: ${error.message}`,
            hint: CONFIG_HINT,
          }),
      ),
    );
    return yield* decodeConfig(path, content);
  });
