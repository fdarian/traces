import { Console, Effect, Redacted, Stream } from 'effect';
import { Argument, Command, Prompt } from 'effect/cli';
import { Stdio } from 'effect/Stdio';
import { UsageError } from '#/errors.ts';
import { Secrets } from '#/secrets.ts';

export const secretOptions = {
  name: Argument.String('name'),
};

const requireName = (name: string) =>
  name.trim() === ''
    ? new UsageError({
        message: 'secret name must not be empty',
        hint: 'use the name from the config, e.g. `traces secret set mockingbird.jaeger`',
      })
    : Effect.succeed(name);

/** Drops one trailing newline (what `echo` and here-strings append) and refuses what is left if empty. */
export const parseSecretValue = (raw: string) => {
  const value = raw.replace(/\r?\n$/, '');
  return value === ''
    ? new UsageError({
        message: 'refusing to store an empty secret value',
        hint: 'pipe the value in, e.g. `pbpaste | traces secret set <name>`, or run it in a terminal for the hidden prompt',
      })
    : Effect.succeed(value);
};

/** Hidden prompt on a TTY, stdin otherwise. The value never goes through logging or an error message. */
export const readSecretValue = (name: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio;
    const raw = (yield* stdio.stdinIsTerminal)
      ? Redacted.value(yield* Prompt.Hidden({ message: `Value for ${name}` }))
      : yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
    return yield* parseSecretValue(raw);
  });

const setCommand = Command.make('set', secretOptions, (args) =>
  Effect.gen(function* () {
    const name = yield* requireName(args.name);
    const value = yield* readSecretValue(name);
    yield* Secrets.use((secrets) => secrets.set(name, value));
    yield* Console.error(`stored secret "${name}" in the keychain`);
  }),
);

const deleteCommand = Command.make('delete', secretOptions, (args) =>
  Effect.gen(function* () {
    const name = yield* requireName(args.name);
    const existed = yield* Secrets.use((secrets) => secrets.delete(name));
    yield* Console.error(
      existed
        ? `deleted secret "${name}" from the keychain`
        : `no secret named "${name}" in the keychain; nothing to delete`,
    );
  }),
);

export const secretCommand = Command.make('secret').pipe(
  Command.withSubcommands([setCommand, deleteCommand]),
);
