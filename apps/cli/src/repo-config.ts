import { basename, dirname, join } from 'node:path';
import { Effect, Option } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { type ProjectSettings, readRepoConfig } from '#/config.ts';
import { UsageError } from '#/errors.ts';
import { isPathMatch, readGitToplevel } from '#/project-match.ts';

export const REPO_CONFIG_FILE = 'traces.json';

export interface RepoConfigFound {
  readonly path: string;
  readonly name: string;
  readonly project: ProjectSettings;
}

/** Directories from `cwd` up to `toplevel`, inclusive. */
const directoriesUpTo = (cwd: string, toplevel: string) => {
  const directories = [cwd];
  let current = cwd;
  while (current !== toplevel && dirname(current) !== current) {
    current = dirname(current);
    directories.push(current);
  }
  return directories;
};

/**
 * Inside a git repo the walk stops at the toplevel, so a stray `traces.json`
 * above the repo is never picked up. Outside one only `cwd` is checked.
 */
export const findRepoConfig = (cwd: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const canonicalCwd = yield* fileSystem.realPath(cwd);
    const toplevel = yield* readGitToplevel(canonicalCwd);
    const root = Option.filter(toplevel, (top) =>
      isPathMatch(top, canonicalCwd),
    );
    const directories = Option.isSome(root)
      ? directoriesUpTo(canonicalCwd, root.value)
      : [canonicalCwd];
    for (const directory of directories) {
      const path = join(directory, REPO_CONFIG_FILE);
      const config = yield* readRepoConfig(path);
      if (Option.isNone(config)) continue;
      return Option.some({
        path,
        name:
          config.value.name ??
          basename(Option.getOrElse(root, () => directory)),
        project: {
          ...(config.value.tracing === undefined
            ? {}
            : { tracing: config.value.tracing }),
          services: config.value.services,
        },
      } satisfies RepoConfigFound);
    }
    return Option.none<RepoConfigFound>();
  }).pipe(
    Effect.catchTag('PlatformError', (error) =>
      Effect.fail(
        new UsageError({
          message: `cannot inspect the current directory: ${error.message}`,
          hint: 'run from an existing directory',
        }),
      ),
    ),
  );
