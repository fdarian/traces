import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { ConfigProvider, Effect, Layer, Option } from 'effect';
import { EXIT_CODES, renderError } from '#/output.ts';
import {
  Keychain,
  keychainCantPrompt,
  SecretFileError,
  SecretMissing,
  SecretStoreError,
  Secrets,
} from '#/secrets.ts';

let xdg: string;

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), 'traces-secrets-'));
});

afterEach(() => {
  rmSync(xdg, { recursive: true, force: true });
});

const configDir = () => join(xdg, 'traces');
const secretsFile = () => join(configDir(), 'secrets.json');
const writeSecretsFile = (content: string) => {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(secretsFile(), content);
};
const modeOf = (path: string) => statSync(path).mode & 0o777;

const fakeKeychain = (
  entries: Record<string, string>,
  failure?: SecretStoreError,
) => {
  const stored = new Map(Object.entries(entries));
  const layer = Layer.succeed(Keychain, {
    get: (name: string) =>
      failure === undefined
        ? Effect.succeed(Option.fromNullishOr(stored.get(name)))
        : Effect.fail(failure),
    set: (name: string, value: string) =>
      Effect.sync(() => void stored.set(name, value)),
    delete: (name: string) =>
      failure === undefined
        ? Effect.sync(() => stored.delete(name))
        : Effect.fail(failure),
  });
  return { layer, stored };
};

const run = <A, E>(
  keychain: Layer.Layer<Keychain>,
  program: (secrets: Secrets['Service']) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Secrets.use(program).pipe(
      Effect.provide(
        Secrets.layer.pipe(
          Layer.provide(keychain),
          Layer.provide(BunServices.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: xdg }),
            ),
          ),
        ),
      ),
    ),
  );

const cantPrompt = new SecretStoreError({
  operation: 'get',
  name: 'app.railway',
  cause: new Error('User interaction is not allowed. (code: -25308)'),
});

describe('Secrets lookup order', () => {
  test('the file wins over the keychain', async () => {
    writeSecretsFile(JSON.stringify({ 'app.jaeger': 'from-file' }));
    const keychain = fakeKeychain({ 'app.jaeger': 'from-keychain' });
    expect(await run(keychain.layer, (s) => s.get('app.jaeger'))).toBe(
      'from-file',
    );
  });

  test('the keychain is used when the file lacks the name', async () => {
    writeSecretsFile(JSON.stringify({ other: 'x' }));
    const keychain = fakeKeychain({ 'app.jaeger': 'from-keychain' });
    expect(await run(keychain.layer, (s) => s.get('app.jaeger'))).toBe(
      'from-keychain',
    );
  });

  test('a missing file is an empty file', async () => {
    const keychain = fakeKeychain({ 'app.jaeger': 'from-keychain' });
    expect(await run(keychain.layer, (s) => s.get('app.jaeger'))).toBe(
      'from-keychain',
    );
  });

  test('a name in neither store fails as SecretMissing', async () => {
    const result = await run(fakeKeychain({}).layer, (s) =>
      s.get('app.jaeger').pipe(Effect.flip),
    );
    expect(result).toBeInstanceOf(SecretMissing);
  });

  test('a file hit never touches the keychain', async () => {
    writeSecretsFile(JSON.stringify({ 'app.railway': 'from-file' }));
    const keychain = fakeKeychain({}, cantPrompt);
    expect(await run(keychain.layer, (s) => s.get('app.railway'))).toBe(
      'from-file',
    );
  });

  test('a keychain error is not hidden when the file lacks the name', async () => {
    const result = await run(fakeKeychain({}, cantPrompt).layer, (s) =>
      s.get('app.railway').pipe(Effect.flip),
    );
    expect(result).toBeInstanceOf(SecretStoreError);
  });

  test('inherited object keys are not secrets', async () => {
    writeSecretsFile('{}');
    const result = await run(fakeKeychain({}).layer, (s) =>
      s.get('constructor').pipe(Effect.flip),
    );
    expect(result).toBeInstanceOf(SecretMissing);
  });
});

describe('Secrets.source', () => {
  test('reports the file and whether the keychain also holds the name', async () => {
    writeSecretsFile(JSON.stringify({ a: '1', b: '2' }));
    const keychain = fakeKeychain({ a: 'kc' });
    expect(await run(keychain.layer, (s) => s.source('a'))).toEqual({
      store: 'file',
      shadowed: true,
    });
    expect(await run(keychain.layer, (s) => s.source('b'))).toEqual({
      store: 'file',
      shadowed: false,
    });
  });

  test('a keychain error while probing does not count as shadowed', async () => {
    writeSecretsFile(JSON.stringify({ a: '1' }));
    expect(
      await run(fakeKeychain({}, cantPrompt).layer, (s) => s.source('a')),
    ).toEqual({ store: 'file', shadowed: false });
  });

  test('reports the keychain when the file lacks the name', async () => {
    expect(
      await run(fakeKeychain({ a: 'kc' }).layer, (s) => s.source('a')),
    ).toEqual({ store: 'keychain', shadowed: false });
  });

  test('fails as SecretMissing or SecretStoreError otherwise', async () => {
    expect(
      await run(fakeKeychain({}).layer, (s) => s.source('a').pipe(Effect.flip)),
    ).toBeInstanceOf(SecretMissing);
    expect(
      await run(fakeKeychain({}, cantPrompt).layer, (s) =>
        s.source('a').pipe(Effect.flip),
      ),
    ).toBeInstanceOf(SecretStoreError);
  });
});

describe('secrets file writes', () => {
  test('create the file with mode 0600 and the directory with mode 0700', async () => {
    const keychain = fakeKeychain({});
    await run(keychain.layer, (s) => s.set('app.railway', 'tok', 'file'));
    expect(modeOf(secretsFile())).toBe(0o600);
    expect(modeOf(configDir())).toBe(0o700);
    expect(JSON.parse(readFileSync(secretsFile(), 'utf8'))).toEqual({
      'app.railway': 'tok',
    });
    expect(keychain.stored.size).toBe(0);
  });

  test('leave an existing directory mode alone and keep other entries', async () => {
    mkdirSync(configDir(), { recursive: true });
    chmodSync(configDir(), 0o755);
    writeSecretsFile(JSON.stringify({ keep: 'k' }));
    await run(fakeKeychain({}).layer, (s) => s.set('new', 'n', 'file'));
    expect(modeOf(configDir())).toBe(0o755);
    expect(modeOf(secretsFile())).toBe(0o600);
    expect(JSON.parse(readFileSync(secretsFile(), 'utf8'))).toEqual({
      keep: 'k',
      new: 'n',
    });
  });

  test('leave no temp file behind', async () => {
    await run(fakeKeychain({}).layer, (s) => s.set('a', '1', 'file'));
    await run(fakeKeychain({}).layer, (s) => s.delete('a', 'file'));
    expect(Bun.spawnSync(['ls', configDir()]).stdout.toString().trim()).toBe(
      'secrets.json',
    );
  });

  test('set to the keychain store leaves the file alone', async () => {
    const keychain = fakeKeychain({});
    await run(keychain.layer, (s) => s.set('a', '1', 'keychain'));
    expect(keychain.stored.get('a')).toBe('1');
    expect(existsSync(configDir())).toBe(false);
  });
});

describe('Secrets.delete', () => {
  test('removes from the file only and says so', async () => {
    writeSecretsFile(JSON.stringify({ a: '1', b: '2' }));
    const keychain = fakeKeychain({});
    expect(await run(keychain.layer, (s) => s.delete('a', 'file'))).toBe(true);
    expect(await run(keychain.layer, (s) => s.delete('a', 'keychain'))).toBe(
      false,
    );
    expect(JSON.parse(readFileSync(secretsFile(), 'utf8'))).toEqual({ b: '2' });
  });

  test('removes from both stores independently', async () => {
    writeSecretsFile(JSON.stringify({ a: '1' }));
    const keychain = fakeKeychain({ a: 'kc' });
    const held = await run(keychain.layer, (s) =>
      Effect.all([s.delete('a', 'file'), s.delete('a', 'keychain')]),
    );
    expect(held).toEqual([true, true]);
    expect(keychain.stored.has('a')).toBe(false);
    expect(JSON.parse(readFileSync(secretsFile(), 'utf8'))).toEqual({});
  });

  test('neither store holding the name is false twice and creates nothing', async () => {
    const held = await run(fakeKeychain({}).layer, (s) =>
      Effect.all([s.delete('a', 'file'), s.delete('a', 'keychain')]),
    );
    expect(held).toEqual([false, false]);
    expect(existsSync(configDir())).toBe(false);
  });
});

describe('Secrets.fileStatus', () => {
  test('is none without a file and carries the permission bits with one', async () => {
    const keychain = fakeKeychain({});
    expect(await run(keychain.layer, (s) => s.fileStatus)).toEqual(
      Option.none(),
    );
    writeSecretsFile('{}');
    chmodSync(secretsFile(), 0o644);
    expect(await run(keychain.layer, (s) => s.fileStatus)).toEqual(
      Option.some({ path: secretsFile(), mode: 0o644 }),
    );
  });
});

describe('a broken secrets file', () => {
  const broken: ReadonlyArray<readonly [string, string]> = [
    ['invalid JSON', 'not json'],
    ['a JSON array', '["a"]'],
    ['null', 'null'],
    ['a non-string value', '{"a": 1}'],
  ];

  for (const [label, content] of broken) {
    test(`${label} fails as SecretFileError without echoing the content`, async () => {
      writeSecretsFile(content);
      const error = await run(fakeKeychain({}).layer, (s) =>
        s.get('a').pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(SecretFileError);
      if (error instanceof SecretFileError) {
        expect(error.operation).toBe('get');
        expect(error.path).toBe(secretsFile());
        expect(renderError(error).message).not.toContain(content);
      }
    });
  }

  test('an unreadable file fails as SecretFileError', async () => {
    mkdirSync(secretsFile(), { recursive: true });
    const error = await run(fakeKeychain({}).layer, (s) =>
      s.get('a').pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SecretFileError);
  });
});

describe('keychainCantPrompt', () => {
  const failing = (cause: unknown) =>
    new SecretStoreError({ operation: 'get', name: 'a', cause });

  test('matches the status code in Bun’s message', () => {
    for (const status of [-25308, -25293, -25294]) {
      expect(
        keychainCantPrompt(failing(new Error(`Whatever. (code: ${status})`))),
      ).toBe(true);
    }
  });

  test('matches the error codes Bun sets', () => {
    for (const code of [
      'ERR_SECRETS_INTERACTION_NOT_ALLOWED',
      'ERR_SECRETS_AUTH_FAILED',
    ]) {
      expect(
        keychainCantPrompt(failing(Object.assign(new Error('x'), { code }))),
      ).toBe(true);
    }
  });

  test('rejects other failures', () => {
    expect(
      keychainCantPrompt(
        failing(new Error('The item is read only. (code: -25244)')),
      ),
    ).toBe(false);
    expect(keychainCantPrompt(failing(new Error('keychain is locked')))).toBe(
      false,
    );
    expect(keychainCantPrompt(failing('plain string'))).toBe(false);
  });
});

describe('error rendering', () => {
  test('a -25308 keychain error hints at --insecure-storage for that secret', () => {
    const rendered = renderError(cantPrompt);
    expect(rendered.code).toBe(EXIT_CODES.runtime);
    expect(rendered.hint).toBe(
      "the keychain can't prompt in this session (SSH?); store it in a file instead: `traces secret set app.railway --insecure-storage`",
    );
  });

  test('other keychain errors keep the unlock hint', () => {
    const rendered = renderError(
      new SecretStoreError({
        operation: 'get',
        name: 'a',
        cause: new Error('keychain is locked'),
      }),
    );
    expect(rendered.hint).toBe('unlock the keychain and retry');
  });

  test('SecretMissing names both stores', () => {
    const rendered = renderError(new SecretMissing({ name: 'a' }));
    expect(rendered.message).toBe(
      'secret "a" is not in the secrets file or the keychain',
    );
    expect(rendered.hint).toBe('traces secret set a');
  });

  test('SecretFileError names the operation, path and cause', () => {
    const rendered = renderError(
      new SecretFileError({
        operation: 'set',
        path: '/x/secrets.json',
        cause: new Error('EACCES'),
      }),
    );
    expect(rendered.message).toBe(
      'secrets file set failed (/x/secrets.json): EACCES',
    );
    expect(rendered.hint).toBe(
      'check that /x/secrets.json is readable and valid JSON',
    );
    expect(rendered.code).toBe(EXIT_CODES.runtime);
  });
});

describe('traces secret set --insecure-storage', () => {
  test('writes the file, never the keychain, and says where on stderr', async () => {
    const child = Bun.spawn(
      [
        'bun',
        'src/main.ts',
        'secret',
        'set',
        'app.railway',
        '--insecure-storage',
      ],
      {
        cwd: join(import.meta.dir, '..'),
        stdin: new Response('tok\n'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, XDG_CONFIG_HOME: xdg },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe(
      `stored secret "app.railway" in ${secretsFile()} (plain text, mode 0600)\n`,
    );
    expect(JSON.parse(readFileSync(secretsFile(), 'utf8'))).toEqual({
      'app.railway': 'tok',
    });
    expect(modeOf(secretsFile())).toBe(0o600);
  });
});
