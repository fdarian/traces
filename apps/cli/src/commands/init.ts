import { join } from 'node:path';
import {
  fetchVercelProjectName,
  makeRailwayCliClient,
  type ProviderError,
  railwayLinkedProject,
  railwayProjectLayout,
} from '@traces/core';
import { Console, Effect, Option } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FileSystem } from 'effect/FileSystem';
import { hasLogProvider, type LogServiceConfig } from '#/config.ts';
import { NothingDiscovered, UsageError } from '#/errors.ts';
import {
  assignServiceKeys,
  buildTracing,
  findVercelLinks,
  keychainSecrets,
  type ServiceCandidate,
  validateRepoConfig,
  vercelTeamOf,
} from '#/init.ts';
import { renderError } from '#/output.ts';
import { readGitToplevel } from '#/project-match.ts';
import { REPO_CONFIG_FILE } from '#/repo-config.ts';
import { findVercelToken } from '#/vercel-token.ts';

export const initOptions = {
  'railway-project': Flag.String('railway-project').pipe(
    Flag.withDescription(
      'Railway project id to read services from (default: the project `railway status --json` reports for the git root; a failure there is a stderr note, not an error)',
    ),
    Flag.optional,
  ),
  'jaeger-url': Flag.String('jaeger-url').pipe(
    Flag.withDescription(
      'add `tracing: {provider: jaeger, url}`; without it there is no tracing block',
    ),
    Flag.optional,
  ),
  'jaeger-header': Flag.String('jaeger-header').pipe(
    Flag.withDescription(
      'Name=keychain:<secret>: a tracing header whose value is read from that keychain secret at use time; repeatable; needs --jaeger-url',
    ),
    Flag.atLeast(0),
  ),
  force: Flag.Boolean('force').pipe(
    Flag.withDescription(
      'overwrite an existing traces.json (default: refuse, exit 2)',
    ),
    Flag.withDefault(false),
  ),
  'dry-run': Flag.Boolean('dry-run').pipe(
    Flag.withDescription('print the JSON to stdout and write nothing'),
    Flag.withDefault(false),
  ),
};

const describeProviderError = (error: ProviderError) => {
  const rendered = renderError(error);
  return rendered.hint === undefined
    ? rendered.message
    : `${rendered.message} (${rendered.hint})`;
};

const railwayCandidates = (
  toplevel: string,
  explicitProject: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const projectId = Option.isSome(explicitProject)
      ? explicitProject.value
      : (yield* railwayLinkedProject(toplevel)).id;
    // No config exists yet to say how to reach Railway, so discovery always uses the `railway` CLI, like the folder link.
    const client = yield* makeRailwayCliClient;
    const layout = yield* railwayProjectLayout(client, projectId);
    // `railway status --json` does not say which environment is linked, so the
    // only one that can be picked is the conventional default.
    const hasProduction = layout.environments.some(
      (environment) => environment.name === 'production',
    );
    return layout.services.map(
      (service): ServiceCandidate => ({
        name: service.name,
        config: {
          provider: 'railway',
          project: projectId,
          service: service.name,
          ...(hasProduction ? { environment: 'production' } : {}),
        },
      }),
    );
  }).pipe(
    // Only a discovery the user did not ask for may be skipped.
    Effect.catch((error: ProviderError) =>
      Option.isSome(explicitProject)
        ? Effect.fail(error)
        : Console.error(
            `note: railway: skipped: ${describeProviderError(error)}`,
          ).pipe(Effect.as([] as ReadonlyArray<ServiceCandidate>)),
    ),
  );

const vercelCandidates = (toplevel: string) =>
  Effect.gen(function* () {
    const links = yield* findVercelLinks(toplevel);
    if (links.length === 0) return [];
    const token = yield* findVercelToken.pipe(Effect.result);
    if (token._tag === 'Failure') {
      yield* Console.error(
        `note: vercel: naming projects from .vercel/project.json, not the API (${token.failure.hint})`,
      );
    }
    const candidates: Array<ServiceCandidate> = [];
    for (const link of links) {
      const config: LogServiceConfig = {
        provider: 'vercel',
        project: link.projectId,
        ...vercelTeamOf(link.orgId),
      };
      if (token._tag === 'Failure') {
        candidates.push({ name: link.fallbackName, config });
        continue;
      }
      const name = yield* fetchVercelProjectName(
        { id: link.projectId, ...vercelTeamOf(link.orgId) },
        token.success.token,
      ).pipe(
        Effect.catch((error: ProviderError) =>
          Console.error(
            `note: vercel: could not read project ${link.projectId}, naming it "${link.fallbackName}": ${describeProviderError(error)}`,
          ).pipe(Effect.as(link.fallbackName)),
        ),
      );
      candidates.push({ name, config });
    }
    return candidates;
  });

const formatService = (key: string, ref: LogServiceConfig) => {
  const target =
    ref.provider === 'railway'
      ? `${ref.service} ${ref.environment ?? '-'} `
      : ref.team === undefined
        ? ''
        : `team ${ref.team} `;
  return `${key.padEnd(16)} ${ref.provider.padEnd(8)} ${target}project ${ref.project}`;
};

export const initCommand = Command.make('init', initOptions, (args) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const cwd = yield* fileSystem.realPath(process.cwd());
    const toplevel = yield* readGitToplevel(cwd);
    if (Option.isNone(toplevel)) {
      return yield* new UsageError({
        message: 'not inside a git repository',
        hint: 'run `traces init` from the repo; it writes traces.json at the git root',
      });
    }
    const path = join(toplevel.value, REPO_CONFIG_FILE);
    const exists = yield* fileSystem.exists(path);
    if (exists && !args.force && !args['dry-run']) {
      return yield* new UsageError({
        message: `${path} already exists`,
        hint: 'pass --force to overwrite it, or edit it by hand',
      });
    }
    const tracing = yield* buildTracing(
      args['jaeger-url'],
      args['jaeger-header'],
    );
    const railway = yield* railwayCandidates(
      toplevel.value,
      args['railway-project'],
    );
    const vercel = yield* vercelCandidates(toplevel.value);
    const candidates = [...railway, ...vercel];
    if (candidates.length === 0) return yield* new NothingDiscovered();

    const usesRailway = candidates.some(
      (candidate) => candidate.config.provider === 'railway',
    );
    // Discovery just ran through the `railway` CLI, so it is known to work for this user.
    const config = yield* validateRepoConfig({
      ...(usesRailway ? { railway: { auth: 'cli' } } : {}),
      ...(Option.isSome(tracing) ? { tracing: tracing.value } : {}),
      services: assignServiceKeys(candidates),
    });
    const content = `${JSON.stringify(config, null, 2)}\n`;

    if (args['dry-run']) {
      if (exists) {
        yield* Console.error(
          `note: ${path} exists; without --dry-run, init refuses unless --force is given`,
        );
      }
      return yield* Console.log(content.trimEnd());
    }
    yield* fileSystem.writeFileString(path, content);
    yield* Console.error(`wrote ${path}`);
    for (const [key, ref] of Object.entries(config.services)) {
      if (!hasLogProvider(ref)) continue;
      yield* Console.log(formatService(key, ref));
    }
    const secrets = keychainSecrets(config.tracing);
    yield* Console.error(
      [
        'next:',
        ...(usesRailway
          ? [
              '  railway.auth is "cli" (the logged-in railway CLI); to use a token instead, set {"keychain"} or {"env"}: see `traces skills get core --file references/config.md`',
            ]
          : []),
        '  traces services   (verify)',
        ...secrets.map((name) => `  traces secret set ${name}`),
        `  commit ${REPO_CONFIG_FILE}`,
      ].join('\n'),
    );
  }),
).pipe(
  Command.withShortDescription(
    'write traces.json at the git root from Railway and Vercel',
  ),
  Command.withDescription(
    'Write <git root>/traces.json, discovering the services from the linked Railway project and every Vercel-linked folder, so no config has to be written by hand. Run it from inside the repo; outside a git repository it exits 2. Takes no global flags. See `traces skills get core --file references/commands.md` for what it discovers.',
  ),
  Command.withExamples([
    { command: 'traces init --dry-run' },
    { command: 'traces init' },
    {
      command:
        'traces init --jaeger-url https://jaeger.example.com --jaeger-header X-API-Key=keychain:myapp.jaeger',
    },
  ]),
);
