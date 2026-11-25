import { Console, Effect, Redacted, Stream } from 'effect';
import { Argument, Command, Flag, Prompt } from 'effect/cli';
import { Stdio } from 'effect/Stdio';
import { UsageError } from '#/errors.ts';
import { Secrets } from '#/secrets.ts';

export const secretOptions = {
  name: Argument.String('name').pipe(
    Argument.withDescription(
      'the secret name used in the config, e.g. mockingbird.jaeger',
    ),
  ),
};

const setOptions = {
  ...secretOptions,
  'insecure-storage': Flag.Boolean('insecure-storage').pipe(
    Flag.withDescription(
      'store the value as plain text in the secrets file (mode 0600) instead of the keychain; the way to run over SSH or headless, where the keychain cannot prompt. The file is read before the keychain',
    ),
    Flag.withDefault(false),
  ),
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

const setCommand = Command.make('set', setOptions, (args) =>
  Effect.gen(function* () {
    const name = yield* requireName(args.name);
    const value = yield* readSecretValue(name);
    const secrets = yield* Secrets;
    if (args['insecure-storage']) {
      yield* secrets.set(name, value, 'file');
      yield* Console.error(
        `stored secret "${name}" in ${secrets.filePath} (plain text, mode 0600)`,
      );
    } else {
      yield* secrets.set(name, value, 'keychain');
      yield* Console.error(`stored secret "${name}" in the keychain`);
    }
  }),
).pipe(
  Command.withShortDescription('store a secret value'),
  Command.withDescription(
    'Store the value of a secret, in the OS keychain by default or with --insecure-storage in a plain-text file (~/.config/traces/secrets.json, mode 0600; respects XDG_CONFIG_HOME). Use --insecure-storage to run over SSH or headless, where the keychain cannot prompt: the file is read before the keychain, so the same config works on both. The value comes from a hidden prompt on a terminal, or from stdin when piped (one trailing newline is dropped); an empty value is refused. Agents cannot answer the hidden prompt: the user runs it once.',
  ),
  Command.withExamples([
    { command: 'traces secret set mockingbird.jaeger' },
    {
      command: 'pbpaste | traces secret set mockingbird.jaeger',
      description: 'from stdin',
    },
    {
      command: 'traces secret set mockingbird.railway --insecure-storage',
      description: 'for SSH or headless machines',
    },
  ]),
);

const deleteCommand = Command.make('delete', secretOptions, (args) =>
  Effect.gen(function* () {
    const name = yield* requireName(args.name);
    const secrets = yield* Secrets;
    const inFile = yield* secrets.delete(name, 'file');
    if (inFile) {
      yield* Console.error(`deleted secret "${name}" from ${secrets.filePath}`);
    }
    const inKeychain = yield* secrets.delete(name, 'keychain');
    if (inKeychain) {
      yield* Console.error(`deleted secret "${name}" from the keychain`);
    }
    if (!inFile && !inKeychain) {
      yield* Console.error(
        `no secret named "${name}" in the secrets file or the keychain; nothing to delete`,
      );
    }
  }),
).pipe(
  Command.withShortDescription('remove a secret'),
  Command.withDescription(
    'Remove a secret from both the secrets file and the keychain, saying on stderr which held it. A name that does not exist exits 0 and says so on stderr.',
  ),
  Command.withExamples([
    { command: 'traces secret delete mockingbird.jaeger' },
  ]),
);

export const secretCommand = Command.make('secret').pipe(
  Command.withShortDescription(
    'store or remove a secret (tracing headers, the Railway token); --insecure-storage for SSH or headless',
  ),
  Command.withDescription(
    'Manage the secrets that tracing headers and a Railway token (`railway.auth`) refer to as {"keychain": "<name>"}. A ref is looked up in the plain-text secrets file first, then in the OS keychain (service `traces`). `set` writes to the keychain unless given --insecure-storage, which writes the file instead: use it over SSH or on a headless machine, where the keychain cannot prompt. Values are never printed or logged. There is no `list`: `traces services` shows present or missing for every secret the config references.',
  ),
  Command.withSubcommands([setCommand, deleteCommand]),
);
