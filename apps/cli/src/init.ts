import { basename, join } from 'node:path';
import { Console, Effect, Option, Schema } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import {
  type HeaderValue,
  type LogServiceConfig,
  RepoConfigSchema,
  type TracingConfig,
} from '#/config.ts';
import { UsageError } from '#/errors.ts';

const SKIPPED_DIRECTORIES = ['node_modules', '.git'];
const VERCEL_LINK_DEPTH = 3;

const VercelLinkFile = Schema.fromJsonString(
  Schema.Struct({
    projectId: Schema.NonEmptyString,
    orgId: Schema.NonEmptyString,
    projectName: Schema.optional(Schema.String),
  }),
);

export interface VercelLink {
  readonly projectId: string;
  readonly orgId: string;
  /** What to call the project when the Vercel API cannot say: the link file's `projectName`, else the folder name. */
  readonly fallbackName: string;
}

/**
 * Every `.vercel/project.json` at most `VERCEL_LINK_DEPTH` folders below `root`
 * (the root is depth 0). These are Vercel CLI link files: ids, not secrets.
 * A file that cannot be read or decoded is reported to stderr and skipped.
 */
export const findVercelLinks = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const links: Array<VercelLink> = [];
    const visit = (
      directory: string,
      depth: number,
    ): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const linkPath = join(directory, '.vercel', 'project.json');
        const content = yield* fileSystem.readFileString(linkPath).pipe(
          Effect.map(Option.some),
          Effect.catchTag('PlatformError', (error) =>
            error.reason._tag === 'NotFound'
              ? Effect.succeed(Option.none<string>())
              : Console.error(
                  `note: skipping ${linkPath}: ${error.message}`,
                ).pipe(Effect.as(Option.none<string>())),
          ),
        );
        if (Option.isSome(content)) {
          const decoded = yield* Schema.decodeUnknownEffect(VercelLinkFile)(
            content.value,
          ).pipe(Effect.result);
          if (decoded._tag === 'Success') {
            links.push({
              projectId: decoded.success.projectId,
              orgId: decoded.success.orgId,
              fallbackName:
                decoded.success.projectName === undefined ||
                decoded.success.projectName === ''
                  ? basename(directory)
                  : decoded.success.projectName,
            });
          } else {
            yield* Console.error(
              `note: skipping ${linkPath}: not a Vercel link file with projectId and orgId`,
            );
          }
        }
        if (depth >= VERCEL_LINK_DEPTH) return;
        const entries = yield* fileSystem
          .readDirectoryEntries(directory)
          .pipe(
            Effect.catchTag('PlatformError', (error) =>
              Console.error(
                `note: not searching ${directory} for .vercel/project.json: ${error.message}`,
              ).pipe(Effect.as([])),
            ),
          );
        const subdirectories = entries
          .filter(
            (entry) =>
              entry.type === 'Directory' &&
              !SKIPPED_DIRECTORIES.includes(entry.name),
          )
          .map((entry) => entry.name)
          .sort();
        for (const name of subdirectories) {
          yield* visit(join(directory, name), depth + 1);
        }
      });
    yield* visit(root, 0);
    const seen = new Set<string>();
    return links.filter((link) => {
      const identity = `${link.orgId}/${link.projectId}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  });

/** A personal Vercel account's orgId is a user id, which is not a team; only `team_` ids are. */
export const vercelTeamOf = (orgId: string): { readonly team?: string } =>
  orgId.startsWith('team_') ? { team: orgId } : {};

/** Collapses anything outside the config's identifier alphabet to `-`; empty when nothing usable is left. */
export const slugify = (name: string) =>
  name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

export interface ServiceCandidate {
  /** The provider's own name for the service, before slugifying. */
  readonly name: string;
  readonly config: LogServiceConfig;
}

/**
 * Names that collide across providers get the provider as a suffix
 * (`web-vercel`, `web-railway`); any collision left after that, within one
 * provider, gets a numeric suffix. Candidate order decides who gets the bare
 * number.
 */
export const assignServiceKeys = (
  candidates: ReadonlyArray<ServiceCandidate>,
): Record<string, LogServiceConfig> => {
  const bases = candidates.map(
    (candidate) => slugify(candidate.name) || candidate.config.provider,
  );
  const providersByBase = new Map<string, Set<string>>();
  candidates.forEach((candidate, index) => {
    const base = bases[index];
    if (base === undefined) return;
    const providers = providersByBase.get(base) ?? new Set<string>();
    providers.add(candidate.config.provider);
    providersByBase.set(base, providers);
  });
  const services = new Map<string, LogServiceConfig>();
  candidates.forEach((candidate, index) => {
    const base = bases[index];
    if (base === undefined) return;
    const crossProvider = (providersByBase.get(base)?.size ?? 0) > 1;
    const preferred = crossProvider
      ? `${base}-${candidate.config.provider}`
      : base;
    let key = preferred;
    for (let attempt = 2; services.has(key); attempt++) {
      key = `${preferred}-${attempt}`;
    }
    services.set(key, candidate.config);
  });
  return Object.fromEntries(services);
};

export const parseJaegerHeader = (
  flag: string,
): Effect.Effect<readonly [name: string, value: HeaderValue], UsageError> => {
  const separator = flag.indexOf('=');
  const name = separator < 0 ? '' : flag.slice(0, separator);
  const value = separator < 0 ? '' : flag.slice(separator + 1);
  const secret = value.startsWith('keychain:')
    ? value.slice('keychain:'.length)
    : '';
  return name === '' || secret === ''
    ? Effect.fail(
        new UsageError({
          message: `cannot parse --jaeger-header "${flag}"`,
          hint: 'use --jaeger-header <Name>=keychain:<secret>, e.g. X-API-Key=keychain:myapp.jaeger; the secret itself is stored with `traces secret set`',
        }),
      )
    : Effect.succeed([name, { keychain: secret }] as const);
};

export const buildTracing = (
  url: Option.Option<string>,
  headerFlags: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (Option.isNone(url)) {
      if (headerFlags.length > 0) {
        return yield* new UsageError({
          message: '--jaeger-header needs --jaeger-url',
          hint: 'pass --jaeger-url <url> as well, or drop the header',
        });
      }
      return Option.none<TracingConfig>();
    }
    const headers = new Map<string, HeaderValue>();
    for (const flag of headerFlags) {
      const [name, value] = yield* parseJaegerHeader(flag);
      if (headers.has(name)) {
        return yield* new UsageError({
          message: `--jaeger-header "${name}" is given twice`,
          hint: 'pass each header name once',
        });
      }
      headers.set(name, value);
    }
    return Option.some<TracingConfig>({
      provider: 'jaeger',
      url: url.value,
      ...(headerFlags.length === 0
        ? {}
        : { headers: Object.fromEntries(headers) }),
    });
  });

/** The object is validated through the same schema the repo file is read with, so what init writes always loads. */
export const validateRepoConfig = (candidate: unknown) =>
  Schema.decodeUnknownEffect(RepoConfigSchema, { onExcessProperty: 'error' })(
    candidate,
  ).pipe(
    Effect.mapError(
      (error) =>
        new UsageError({
          message: `the generated traces.json is not valid: ${error.message}`,
          hint: 'check --jaeger-url and --jaeger-header',
        }),
    ),
  );

export const keychainSecrets = (tracing: TracingConfig | undefined) =>
  tracing?.headers === undefined
    ? []
    : Object.values(tracing.headers).flatMap((value) =>
        typeof value === 'object' && 'keychain' in value
          ? [value.keychain]
          : [],
      );
