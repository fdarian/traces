import { join } from 'node:path';
import {
  fetchVercelProjectName,
  type ProviderError,
  railwayLinkedProject,
  railwayProjectLayout,
} from '@traces/core';
import { Console, Effect, Option } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FileSystem } from 'effect/FileSystem';
import type { LogServiceConfig } from '#/config.ts';
import { NothingDiscovered, UsageError } from '#/errors.ts';
import {
  assignServiceKeys,
  buildTracing,
  findVercelLinks,
  keychainSecrets,
  type ServiceCandidate,
  validateRepoConfig,
} from '#/init.ts';
import { causeMessage, emitRecord, outputMode, renderError } from '#/output.ts';
import { readGitToplevel } from '#/project-match.ts';
import { REPO_CONFIG_FILE } from '#/repo-config.ts';
import { findVercelToken } from '#/vercel-token.ts';

export const initOptions = {
  'railway-project': Flag.String('railway-project').pipe(Flag.optional),
  'jaeger-url': Flag.String('jaeger-url').pipe(Flag.optional),
  'jaeger-header': Flag.String('jaeger-header').pipe(Flag.atLeast(0)),
  force: Flag.Boolean('force').pipe(Flag.withDefault(false)),
  'dry-run': Flag.Boolean('dry-run').pipe(Flag.withDefault(false)),
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
    const layout = yield* railwayProjectLayout(projectId);
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
        team: link.orgId,
      };
      if (token._tag === 'Failure') {
        candidates.push({ name: link.fallbackName, config });
        continue;
      }
      const name = yield* fetchVercelProjectName(
        { id: link.projectId, team: link.orgId },
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

const formatService = (record: {
  readonly service: string;
  readonly ref: LogServiceConfig;
}) =>
  `${record.service.padEnd(16)} ${record.ref.provider.padEnd(8)} project ${record.ref.project}`;

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

    const config = yield* validateRepoConfig({
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
    const mode = outputMode(false);
    for (const [service, ref] of Object.entries(config.services)) {
      if (!('provider' in ref)) continue;
      yield* emitRecord(mode, { path, service, ref }, formatService);
    }
    const secrets = keychainSecrets(config.tracing);
    yield* Console.error(
      [
        'next:',
        '  traces services   (verify)',
        ...secrets.map((name) => `  traces secret set ${name}`),
        `  commit ${REPO_CONFIG_FILE}`,
      ].join('\n'),
    );
  }),
);
