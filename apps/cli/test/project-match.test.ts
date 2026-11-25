import { describe, expect, test } from 'bun:test';
import { Effect, Option } from 'effect';
import type { TracesConfig } from '#/config.ts';
import {
  isPathMatch,
  matchesGitRepo,
  matchProjects,
  normalizeGitRepo,
  selectProject,
} from '#/project-match.ts';

const service = { provider: 'vercel', project: 'p' } as const;

const config: TracesConfig = {
  projects: {
    broad: {
      matcher: { type: 'path', path: '/code' },
      services: { web: service },
    },
    narrow: {
      matcher: { type: 'path', path: '/code/app' },
      services: { web: service },
    },
    byGit: {
      matcher: { type: 'git', repo: 'acme/app' },
      services: { web: service },
    },
    other: {
      matcher: { type: 'git', repo: 'github.com/other/thing' },
      services: { web: service },
    },
  },
};

const matcherPaths = new Map([
  ['broad', '/code'],
  ['narrow', '/code/app'],
]);

describe('normalizeGitRepo', () => {
  test('collapses ssh, scp and https spellings', () => {
    const expected = 'github.com/acme/app';
    expect(normalizeGitRepo('git@github.com:acme/app.git')).toBe(expected);
    expect(normalizeGitRepo('https://github.com/acme/app.git')).toBe(expected);
    expect(normalizeGitRepo('ssh://git@github.com:22/Acme/App')).toBe(expected);
    expect(normalizeGitRepo('https://user@github.com/acme/app/')).toBe(
      expected,
    );
  });

  test('keeps host-less shorthand as owner/repo', () => {
    expect(normalizeGitRepo('Acme/App')).toBe('acme/app');
  });
});

describe('matchesGitRepo', () => {
  test('shorthand matches on a slash boundary only', () => {
    expect(matchesGitRepo('github.com/acme/app', 'acme/app')).toBe(true);
    expect(matchesGitRepo('github.com/xacme/app', 'acme/app')).toBe(false);
    expect(matchesGitRepo('github.com/me/app', 'other/app')).toBe(false);
  });

  test('a configured host must match the remote host', () => {
    expect(matchesGitRepo('gitlab.com/acme/app', 'github.com/acme/app')).toBe(
      false,
    );
    expect(matchesGitRepo('github.com/acme/app', 'github.com/acme/app')).toBe(
      true,
    );
  });
});

describe('isPathMatch', () => {
  test('matches the directory and its descendants, not siblings', () => {
    expect(isPathMatch('/code/app', '/code/app')).toBe(true);
    expect(isPathMatch('/code/app', '/code/app/src')).toBe(true);
    expect(isPathMatch('/code/app', '/code/app2')).toBe(false);
    expect(isPathMatch('/code/app', '/code')).toBe(false);
  });
});

describe('matchProjects', () => {
  test('longest path wins', () => {
    const result = matchProjects(
      config,
      { cwd: '/code/app/src', repo: 'github.com/acme/app' },
      matcherPaths,
    );
    expect(result.matchType).toBe('path');
    expect(result.projects.map((p) => p.name)).toEqual(['narrow']);
  });

  test('path wins over git', () => {
    const result = matchProjects(
      config,
      { cwd: '/code/else', repo: 'github.com/acme/app' },
      matcherPaths,
    );
    expect(result.matchType).toBe('path');
    expect(result.projects.map((p) => p.name)).toEqual(['broad']);
  });

  test('falls back to git when no path matches', () => {
    const result = matchProjects(
      config,
      { cwd: '/elsewhere', repo: 'github.com/acme/app' },
      matcherPaths,
    );
    expect(result.matchType).toBe('git');
    expect(result.projects.map((p) => p.name)).toEqual(['byGit']);
  });

  test('matches nothing without a path or remote hit', () => {
    const result = matchProjects(config, { cwd: '/elsewhere' }, matcherPaths);
    expect(result.matchType).toBe('none');
  });
});

describe('selectProject', () => {
  const base = {
    config,
    configPath: '/cfg.json',
    matcherPaths,
  };

  test('--project overrides cwd matching', async () => {
    const selected = await Effect.runPromise(
      selectProject({
        ...base,
        invocation: { cwd: '/code/app' },
        projectFlag: Option.some('other'),
      }),
    );
    expect(selected.name).toBe('other');
    expect(selected.matchedBy).toBe('flag');
  });

  test('an unmatched cwd names the config path, remote and projects', async () => {
    const result = await Effect.runPromise(
      selectProject({
        ...base,
        invocation: { cwd: '/nowhere', repo: 'github.com/x/y' },
        projectFlag: Option.none(),
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.message).toContain('/cfg.json');
      expect(result.failure.message).toContain('github.com/x/y');
      expect(result.failure.hint).toContain('byGit');
    }
  });

  test('an unknown --project lists the configured ones', async () => {
    const result = await Effect.runPromise(
      selectProject({
        ...base,
        invocation: { cwd: '/code/app' },
        projectFlag: Option.some('missing'),
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure.hint).toContain('narrow');
  });

  test('--project is looked up by own key, so "constructor" is unknown', async () => {
    const result = await Effect.runPromise(
      selectProject({
        ...base,
        invocation: { cwd: '/code/app' },
        projectFlag: Option.some('constructor'),
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.message).toContain(
        'no project named "constructor"',
      );
    }
  });
});
