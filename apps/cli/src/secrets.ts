import { Context, Effect, Layer, Schema } from 'effect';

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

export class Secrets extends Context.Service<Secrets>()('traces/Secrets', {
  make: Effect.succeed({
    get: (name: string) =>
      Effect.tryPromise({
        try: () => Bun.secrets.get({ service: SECRET_SERVICE, name }),
        catch: (cause) =>
          new SecretStoreError({ operation: 'get', name, cause }),
      }).pipe(
        Effect.flatMap((value) =>
          value === null ? new SecretMissing({ name }) : Effect.succeed(value),
        ),
      ),
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
