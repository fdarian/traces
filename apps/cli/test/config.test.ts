import { describe, expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import {
  decodeConfig,
  defaultConfigPath,
  hasLogProvider,
  otelServiceName,
  readConfig,
} from '#/config.ts';

const decode = (value: unknown) =>
  Effect.runPromise(
    decodeConfig('/cfg.json', JSON.stringify(value)).pipe(Effect.result),
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
    expect(result._tag).toBe('Success');
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
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure.message).toContain('region');
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
    expect(result._tag).toBe('Failure');
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
    expect(result._tag).toBe('Failure');
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
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.message).toContain('absolute');
    }
  });

  test('rejects a project with no services', async () => {
    const result = await decode({
      projects: { app: { matcher: valid.projects.app.matcher, services: {} } },
    });
    expect(result._tag).toBe('Failure');
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
    expect(result._tag).toBe('Failure');
  });

  test('reports malformed JSON as a config error carrying the path', async () => {
    const result = await Effect.runPromise(
      decodeConfig('/cfg.json', '{nope').pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure.path).toBe('/cfg.json');
  });
});

describe('config error hints', () => {
  test('a missing file points at traces init and names the path to create', async () => {
    const path = '/nonexistent/traces/config.json';
    const result = await Effect.runPromise(
      readConfig(path).pipe(Effect.provide(BunServices.layer), Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.hint).toContain('`traces init`');
      expect(result.failure.hint).toContain(`create ${path}`);
    }
  });

  test('a bad field is named, and the hint does not say to create the file', async () => {
    const result = await decode({
      projects: {
        app: {
          matcher: valid.projects.app.matcher,
          tracing: { provider: 'jaeger', url: 'not a url' },
          services: { web: { provider: 'vercel', project: 'p' } },
        },
      },
    });
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.hint).toContain('projects.app.tracing.url');
      expect(result.failure.hint).not.toContain('create the file');
    }
  });

  test('malformed JSON points at the syntax', async () => {
    const result = await Effect.runPromise(
      decodeConfig('/cfg.json', '{nope').pipe(Effect.result),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.hint).toContain('JSON syntax');
    }
  });
});

const project = (extra: Record<string, unknown>) => ({
  projects: {
    app: {
      matcher: valid.projects.app.matcher,
      services: { web: { provider: 'vercel', project: 'p' } },
      ...extra,
    },
  },
});

describe('config decode: tracing', () => {
  test('accepts literal, env and keychain header values', async () => {
    const result = await decode(
      project({
        tracing: {
          provider: 'jaeger',
          url: 'https://api.example.com/~/jaeger',
          headers: {
            'X-Literal': 'abc',
            'X-Env': { env: 'JAEGER_TOKEN' },
            'X-API-Key': { keychain: 'app.jaeger' },
          },
        },
      }),
    );
    expect(result._tag).toBe('Success');
    if (result._tag === 'Success') {
      expect(result.success.projects.app?.tracing?.headers).toEqual({
        'X-Literal': 'abc',
        'X-Env': { env: 'JAEGER_TOKEN' },
        'X-API-Key': { keychain: 'app.jaeger' },
      });
    }
  });

  test('headers are optional', async () => {
    const result = await decode(
      project({
        tracing: { provider: 'jaeger', url: 'http://localhost:16686' },
      }),
    );
    expect(result._tag).toBe('Success');
  });

  test.each([
    'not a url',
    '/relative/path',
    'ftp://host/x',
    'localhost:16686',
    '',
  ])('rejects tracing.url %p', async (url) => {
    const result = await decode(
      project({ tracing: { provider: 'jaeger', url } }),
    );
    expect(result._tag).toBe('Failure');
  });

  test('names the offending field for a bad url', async () => {
    const result = await decode(
      project({ tracing: { provider: 'jaeger', url: 'nope' } }),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure.message).toContain('absolute http(s) URL');
    }
  });

  test.each([
    ['both env and keychain', { env: 'A', keychain: 'b' }],
    ['an unknown key', { vault: 'x' }],
    ['an empty keychain name', { keychain: '' }],
    ['a number', 5],
  ])('rejects a header value with %s', async (_label, value) => {
    const result = await decode(
      project({
        tracing: {
          provider: 'jaeger',
          url: 'https://j.example.com',
          headers: { 'X-API-Key': value },
        },
      }),
    );
    expect(result._tag).toBe('Failure');
  });

  test('rejects an invalid header name and an unknown provider', async () => {
    const badName = await decode(
      project({
        tracing: {
          provider: 'jaeger',
          url: 'https://j.example.com',
          headers: { 'X API Key': 'v' },
        },
      }),
    );
    expect(badName._tag).toBe('Failure');
    const badProvider = await decode(
      project({ tracing: { provider: 'tempo', url: 'https://j.example.com' } }),
    );
    expect(badProvider._tag).toBe('Failure');
  });
});

describe('config decode: otelService and trace-only services', () => {
  const withServices = (services: Record<string, unknown>) => ({
    projects: { app: { matcher: valid.projects.app.matcher, services } },
  });

  test('otelService is optional on provider services', async () => {
    const result = await decode(
      withServices({
        web: { provider: 'vercel', project: 'p', otelService: 'app-web' },
        api: { provider: 'railway', project: 'p', service: 'api' },
      }),
    );
    expect(result._tag).toBe('Success');
  });

  test('an entry with only otelService is a trace-only service', async () => {
    const result = await decode(
      withServices({
        web: { provider: 'vercel', project: 'p' },
        x: { otelService: 'x-data' },
      }),
    );
    expect(result._tag).toBe('Success');
    if (result._tag === 'Success') {
      const entry = result.success.projects.app?.services.x;
      expect(entry !== undefined && hasLogProvider(entry)).toBe(false);
      expect(entry?.otelService).toBe('x-data');
    }
  });

  test('otelService defaults to the service key', () => {
    expect(otelServiceName('web', { provider: 'vercel', project: 'p' })).toBe(
      'web',
    );
    expect(
      otelServiceName('web', {
        provider: 'vercel',
        project: 'p',
        otelService: 'app-web',
      }),
    ).toBe('app-web');
  });

  test('rejects a trace-only entry that carries provider fields or is empty', async () => {
    for (const entry of [
      { otelService: 'x', project: 'p' },
      { otelService: '' },
      {},
    ]) {
      const result = await decode(withServices({ x: entry }));
      expect(result._tag).toBe('Failure');
    }
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
