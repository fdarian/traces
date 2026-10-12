import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { decodeConfig, defaultConfigPath } from '#/config.ts';

const decode = (value: unknown) =>
  Effect.runPromise(
    decodeConfig('/cfg.json', JSON.stringify(value)).pipe(Effect.either),
  );

const valid = {
  projects: {
    app: {
      matcher: { type: 'git', repo: 'acme/app' },
      services: {
        web: { provider: 'vercel', project: 'app-web', team: 'acme' },
        api: {
          provider: 'railway',
          project: 'proj-id',
          service: 'api',
          environment: 'production',
        },
      },
    },
  },
};

describe('config decode', () => {
  test('accepts a vercel and a railway service', async () => {
    const result = await decode(valid);
    expect(result._tag).toBe('Right');
  });

  test('rejects excess properties with the offending key', async () => {
    const result = await decode({
      projects: {
        app: {
          ...valid.projects.app,
          services: {
            web: { provider: 'vercel', project: 'p', region: 'iad1' },
          },
        },
      },
    });
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left.message).toContain('region');
  });

  test('rejects a service without a provider', async () => {
    const result = await decode({
      projects: {
        app: {
          matcher: valid.projects.app.matcher,
          services: { web: { project: 'p' } },
        },
      },
    });
    expect(result._tag).toBe('Left');
  });

  test('rejects railway services missing the service name', async () => {
    const result = await decode({
      projects: {
        app: {
          matcher: valid.projects.app.matcher,
          services: { api: { provider: 'railway', project: 'p' } },
        },
      },
    });
    expect(result._tag).toBe('Left');
  });

  test('rejects relative path matchers', async () => {
    const result = await decode({
      projects: {
        app: {
          matcher: { type: 'path', path: 'code/app' },
          services: { web: { provider: 'vercel', project: 'p' } },
        },
      },
    });
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left.message).toContain('absolute');
    }
  });

  test('rejects a project with no services', async () => {
    const result = await decode({
      projects: { app: { matcher: valid.projects.app.matcher, services: {} } },
    });
    expect(result._tag).toBe('Left');
  });

  test('rejects names with spaces', async () => {
    const result = await decode({
      projects: {
        'my app': {
          matcher: valid.projects.app.matcher,
          services: { web: { provider: 'vercel', project: 'p' } },
        },
      },
    });
    expect(result._tag).toBe('Left');
  });

  test('reports malformed JSON as a config error carrying the path', async () => {
    const result = await Effect.runPromise(
      decodeConfig('/cfg.json', '{nope').pipe(Effect.either),
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left.path).toBe('/cfg.json');
  });
});

describe('default config path', () => {
  test('uses XDG_CONFIG_HOME when set', () => {
    expect(defaultConfigPath('/home/u', '/xdg')).toBe(
      '/xdg/traces/config.json',
    );
  });

  test('falls back to ~/.config', () => {
    expect(defaultConfigPath('/home/u')).toBe(
      '/home/u/.config/traces/config.json',
    );
  });
});
