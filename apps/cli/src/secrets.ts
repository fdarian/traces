import { join } from 'node:path';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { FileSystem } from 'effect/FileSystem';
import { resolveDefaultConfigDir } from '#/config.ts';

export const SECRET_SERVICE = 'traces';

export class SecretMissing extends Schema.TaggedError<SecretMissing>()(
  'SecretMissing',
  { name: Schema.String },
) {}

/** Keychain failure (locked, denied, unavailable). Never carries the secret value. */
export class SecretStoreError extends Schema.TaggedError<SecretStoreError>()(
  'SecretStoreError',
  {
    operation: Schema.Literals(['get', 'set', 'delete']),
    name: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Secrets file failure (unreadable, not a JSON object of strings, unwritable). Never carries a secret value. */
export class SecretFileError extends Schema.TaggedError<SecretFileError>()(
  'SecretFileError',
  {
    operation: Schema.Literals(['get', 'set', 'delete']),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type SecretStore = 'file' | 'keychain';

const KEYCHAIN_CANT_PROMPT_STATUS = new Set([-25308, -25293, -25294]);

// Bun maps only these two statuses to their own error code; -25294 arrives as ERR_SECRETS_PLATFORM_ERROR, so the status is also read from the message.
const KEYCHAIN_CANT_PROMPT_BUN_CODES = new Set([
  'ERR_SECRETS_INTERACTION_NOT_ALLOWED',
  'ERR_SECRETS_AUTH_FAILED',
]);

const BUN_STATUS_IN_MESSAGE = /\(code: (-?\d+)\)\s*$/;

/** The keychain refused without a user to ask: locked, or access needing a dialog (typical over SSH). */
export const keychainCantPrompt = (error: SecretStoreError): boolean => {
  const cause = error.cause;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    if (
      typeof cause.code === 'string' &&
      KEYCHAIN_CANT_PROMPT_BUN_CODES.has(cause.code)
    ) {
      return true;
    }
    if (
      typeof cause.code === 'number' &&
      KEYCHAIN_CANT_PROMPT_STATUS.has(cause.code)
    ) {
      return true;
    }
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  const status = BUN_STATUS_IN_MESSAGE.exec(message);
  return status !== null && KEYCHAIN_CANT_PROMPT_STATUS.has(Number(status[1]));
};

export class Keychain extends Context.Service<Keychain>()('traces/Keychain', {
  make: Effect.succeed({
    get: (name: string) =>
      Effect.tryPromise({
        try: () => Bun.secrets.get({ service: SECRET_SERVICE, name }),
        catch: (cause) =>
          new SecretStoreError({ operation: 'get', name, cause }),
      }).pipe(Effect.map(Option.fromNullOr)),
    set: (name: string, value: string) =>
      Effect.tryPromise({
        try: () => Bun.secrets.set({ service: SECRET_SERVICE, name, value }),
        catch: (cause) =>
          new SecretStoreError({ operation: 'set', name, cause }),
      }),
    /** Resolves to whether an entry existed. */
    delete: (name: string) =>
      Effect.tryPromise({
        try: () => Bun.secrets.delete({ service: SECRET_SERVICE, name }),
        catch: (cause) =>
          new SecretStoreError({ operation: 'delete', name, cause }),
      }),
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

const SecretsFileJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.String),
);

type Operation = SecretFileError['operation'];

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const lookup = (entries: Readonly<Record<string, string>>, name: string) =>
  Object.hasOwn(entries, name)
    ? Option.fromNullishOr(entries[name])
    : Option.none<string>();

export class Secrets extends Context.Service<Secrets>()('traces/Secrets', {
  make: Effect.gen(function* () {
    const keychain = yield* Keychain;
    const fileSystem = yield* FileSystem;
    const dir = yield* resolveDefaultConfigDir;
    const path = join(dir, 'secrets.json');

    const fileError = (operation: Operation) => (cause: unknown) =>
      new SecretFileError({ operation, path, cause });

    const readFile = (operation: Operation) =>
      fileSystem.readFileString(path).pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          (error) => error.reason._tag === 'NotFound',
          () => Effect.succeed(Option.none<string>()),
        ),
        Effect.mapError(fileError(operation)),
        Effect.flatMap((content) =>
          Option.isNone(content)
            ? Effect.succeed<Record<string, string>>({})
            : Schema.decodeUnknownEffect(SecretsFileJson)(content.value).pipe(
                // The decode issue can quote the offending file content, which may be a secret.
                Effect.mapError(() =>
                  fileError(operation)(
                    new Error('not a JSON object of string values'),
                  ),
                ),
              ),
        ),
      );

    const writeFile = (
      operation: Operation,
      entries: Readonly<Record<string, string>>,
    ) =>
      Effect.gen(function* () {
        const content = yield* Schema.encodeEffect(SecretsFileJson)(entries);
        if (!(yield* fileSystem.exists(dir))) {
          yield* fileSystem.makeDirectory(dir, {
            recursive: true,
            mode: DIR_MODE,
          });
        }
        const temp = `${path}.${crypto.randomUUID()}.tmp`;
        yield* fileSystem
          .writeFileString(temp, `${content}\n`, {
            flag: 'wx',
            mode: FILE_MODE,
          })
          .pipe(
            Effect.andThen(fileSystem.rename(temp, path)),
            Effect.onError(() =>
              fileSystem.remove(temp, { force: true }).pipe(Effect.ignore),
            ),
          );
      }).pipe(Effect.mapError(fileError(operation)));

    const keychainHolds = (name: string) =>
      keychain.get(name).pipe(Effect.map(Option.isSome));

    return {
      filePath: path,
      get: (name: string) =>
        Effect.gen(function* () {
          const entries = yield* readFile('get');
          const fromFile = lookup(entries, name);
          if (Option.isSome(fromFile)) return fromFile.value;
          const value = yield* keychain.get(name);
          return Option.isSome(value)
            ? value.value
            : yield* new SecretMissing({ name });
        }),
      source: (name: string) =>
        Effect.gen(function* () {
          const entries = yield* readFile('get');
          if (Option.isSome(lookup(entries, name))) {
            const shadowed = yield* keychainHolds(name).pipe(
              Effect.orElseSucceed(() => false),
            );
            return { store: 'file', shadowed } as const;
          }
          return (yield* keychainHolds(name))
            ? ({ store: 'keychain', shadowed: false } as const)
            : yield* new SecretMissing({ name });
        }),
      set: (
        name: string,
        value: string,
        store: SecretStore,
      ): Effect.Effect<void, SecretStoreError | SecretFileError> =>
        store === 'keychain'
          ? keychain.set(name, value)
          : readFile('set').pipe(
              Effect.flatMap((entries) =>
                writeFile('set', { ...entries, [name]: value }),
              ),
            ),
      /** Resolves to whether that store held the secret. */
      delete: (
        name: string,
        store: SecretStore,
      ): Effect.Effect<boolean, SecretStoreError | SecretFileError> =>
        store === 'keychain'
          ? keychain.delete(name)
          : Effect.gen(function* () {
              const entries = yield* readFile('delete');
              if (Option.isNone(lookup(entries, name))) return false;
              yield* writeFile(
                'delete',
                Object.fromEntries(
                  Object.entries(entries).filter(([key]) => key !== name),
                ),
              );
              return true;
            }),
      /** `None` when the secrets file does not exist. `mode` is the permission bits only. */
      fileStatus: fileSystem.stat(path).pipe(
        Effect.map((info) => Option.some({ path, mode: info.mode & 0o777 })),
        Effect.catchIf(
          (error) => error.reason._tag === 'NotFound',
          () => Effect.succeed(Option.none<{ path: string; mode: number }>()),
        ),
        Effect.mapError(fileError('get')),
      ),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
