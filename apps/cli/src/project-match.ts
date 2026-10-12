import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { Effect, Option, Stream } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { ChildProcess } from 'effect/process';
import type { ProjectConfig, TracesConfig } from '#/config.ts';
import { UsageError } from '#/errors.ts';

export interface Invocation {
  readonly cwd: string;
  /** Normalized `host/owner/repo` of the cwd's `origin`, when it has one. */
  readonly repo?: string;
}

export interface MatchedProject {
  readonly name: string;
  readonly project: ProjectConfig;
}

export interface ProjectMatches {
  readonly matchType: 'path' | 'git' | 'none';
  readonly projects: ReadonlyArray<MatchedProject>;
}

interface ParsedRepo {
  readonly host?: string;
  readonly path: string;
}

const isHostname = (value: string) =>
  value === 'localhost' || value.includes('.') || isIP(value) !== 0;

const parseGitRepo = (repo: string): ParsedRepo => {
  const trimmed = repo
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const urlRepo = trimmed.match(
    /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i,
  );
  if (urlRepo?.[1] !== undefined && urlRepo[2] !== undefined) {
    return { host: urlRepo[1].toLowerCase(), path: urlRepo[2].toLowerCase() };
  }
  const scpRepo = trimmed.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  if (scpRepo?.[1] !== undefined && scpRepo[2] !== undefined) {
    return { host: scpRepo[1].toLowerCase(), path: scpRepo[2].toLowerCase() };
  }
  const lowered = trimmed.toLowerCase();
  const separator = lowered.indexOf('/');
  if (separator > 0) {
    const host = lowered.slice(0, separator);
    if (isHostname(host)) {
      return { host, path: lowered.slice(separator + 1) };
    }
  }
  return { path: lowered };
};

/** Makes ssh, scp-style and https spellings of the same remote comparable. */
export const normalizeGitRepo = (repo: string): string => {
  const parsed = parseGitRepo(repo);
  return parsed.host === undefined
    ? parsed.path
    : `${parsed.host}/${parsed.path}`;
};

/**
 * A configured repo matches when equal, or when it is an `owner/repo`
 * shorthand landing on a `/` boundary: `acme/app` matches
 * `github.com/acme/app` but `me/app` does not.
 */
export const matchesGitRepo = (
  invocationRepo: string,
  configuredRepo: string,
) => {
  const invocation = parseGitRepo(invocationRepo);
  const configured = parseGitRepo(configuredRepo);
  if (configured.host !== undefined) {
    return (
      invocation.host === configured.host && invocation.path === configured.path
    );
  }
  return (
    invocation.path === configured.path ||
    invocation.path.endsWith(`/${configured.path}`)
  );
};

const expandHome = (path: string) => {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
};

export const isPathMatch = (projectPath: string, cwd: string) => {
  const fromProject = relative(projectPath, cwd);
  return (
    fromProject === '' ||
    (!fromProject.startsWith('../') &&
      fromProject !== '..' &&
      !isAbsolute(fromProject))
  );
};

const namedProjects = (config: TracesConfig): ReadonlyArray<MatchedProject> =>
  Object.keys(config.projects)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((name) => {
      const project = config.projects[name];
      return project === undefined ? [] : [{ name, project }];
    });

/**
 * Path matchers win over git ones, and the longest matching path wins. All
 * equal-longest candidates are returned so the caller can report ambiguity
 * instead of inheriting config key order.
 */
export const matchProjects = (
  config: TracesConfig,
  invocation: Invocation,
  matcherPaths: ReadonlyMap<string, string>,
): ProjectMatches => {
  const pathMatches: Array<{ project: MatchedProject; length: number }> = [];
  for (const candidate of namedProjects(config)) {
    const projectPath = matcherPaths.get(candidate.name);
    if (projectPath === undefined) continue;
    if (isPathMatch(projectPath, invocation.cwd)) {
      pathMatches.push({ project: candidate, length: projectPath.length });
    }
  }
  if (pathMatches.length > 0) {
    const longest = Math.max(...pathMatches.map((match) => match.length));
    return {
      matchType: 'path',
      projects: pathMatches
        .filter((match) => match.length === longest)
        .map((match) => match.project),
    };
  }
  const gitMatches = namedProjects(config).filter(
    (candidate) =>
      candidate.project.matcher.type === 'git' &&
      invocation.repo !== undefined &&
      matchesGitRepo(invocation.repo, candidate.project.matcher.repo),
  );
  return {
    matchType: gitMatches.length > 0 ? 'git' : 'none',
    projects: gitMatches,
  };
};

const readGitOrigin = (cwd: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* ChildProcess.make(
        'git',
        ['remote', 'get-url', 'origin'],
        { cwd },
      );
      const [stdout, exitCode] = yield* Effect.all(
        [
          process.stdout.pipe(Stream.decodeText(), Stream.mkString),
          process.exitCode,
          process.stderr.pipe(Stream.runDrain),
        ],
        { concurrency: 'unbounded' },
      );
      const origin = stdout.trim();
      return exitCode === 0 && origin.length > 0
        ? Option.some(origin)
        : Option.none<string>();
    }),
  ).pipe(
    Effect.catchTag('PlatformError', (error) =>
      error.reason._tag === 'NotFound'
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(error),
    ),
  );

/** Canonical path per path-matcher project; a path that doesn't exist can't match, so it's left out. */
export const resolveMatcherPaths = (config: TracesConfig) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const resolved = new Map<string, string>();
    for (const candidate of namedProjects(config)) {
      const matcher = candidate.project.matcher;
      if (matcher.type !== 'path') continue;
      const canonical = yield* fileSystem
        .realPath(expandHome(matcher.path))
        .pipe(Effect.option);
      if (Option.isSome(canonical))
        resolved.set(candidate.name, canonical.value);
    }
    return resolved;
  });

export const captureInvocation = (cwd: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const canonicalCwd = yield* fileSystem.realPath(cwd);
    const origin = yield* readGitOrigin(canonicalCwd);
    return {
      cwd: canonicalCwd,
      ...(Option.isSome(origin)
        ? { repo: normalizeGitRepo(origin.value) }
        : {}),
    } satisfies Invocation;
  });

export const describeProjects = (config: TracesConfig): string =>
  namedProjects(config)
    .map((entry) => {
      const matcher = entry.project.matcher;
      return `${entry.name} (${matcher.type === 'path' ? `path ${matcher.path}` : `git ${matcher.repo}`})`;
    })
    .join(', ');

export interface SelectedProject extends MatchedProject {
  readonly matchedBy: 'flag' | 'path' | 'git';
}

export const selectProject = (input: {
  readonly config: TracesConfig;
  readonly configPath: string;
  readonly invocation: Invocation;
  readonly matcherPaths: ReadonlyMap<string, string>;
  readonly projectFlag: Option.Option<string>;
}): Effect.Effect<SelectedProject, UsageError> =>
  Effect.gen(function* () {
    if (Option.isSome(input.projectFlag)) {
      const name = input.projectFlag.value;
      const project = input.config.projects[name];
      if (project === undefined) {
        return yield* new UsageError({
          message: `no project named "${name}" in ${input.configPath}`,
          hint: `configured projects: ${describeProjects(input.config)}`,
        });
      }
      return { name, project, matchedBy: 'flag' as const };
    }
    const matches = matchProjects(
      input.config,
      input.invocation,
      input.matcherPaths,
    );
    const first = matches.projects[0];
    if (
      matches.matchType !== 'none' &&
      matches.projects.length === 1 &&
      first
    ) {
      return { ...first, matchedBy: matches.matchType };
    }
    if (matches.projects.length > 1) {
      return yield* new UsageError({
        message: `cwd matches several projects: ${matches.projects.map((entry) => entry.name).join(', ')}`,
        hint: 'pass --project <name>',
      });
    }
    return yield* new UsageError({
      message: `no project in ${input.configPath} matches the current directory (cwd ${input.invocation.cwd}, git remote ${input.invocation.repo ?? 'none'})`,
      hint: `configured projects: ${describeProjects(input.config) || 'none'}; pass --project <name> or add a matcher`,
    });
  });
