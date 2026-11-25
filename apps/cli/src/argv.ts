const GLOBAL_VALUE_FLAGS: ReadonlyArray<string> = [
  '--project',
  '--env',
  '--config',
];
const GLOBAL_BOOLEAN_FLAGS: ReadonlyArray<string> = ['--json'];

/** How many leading tokens `args[index]` takes if it is a global flag; 0 when it is not one. */
const globalFlagWidth = (args: ReadonlyArray<string>, index: number) => {
  const arg = args[index];
  if (arg === undefined) return 0;
  const name = arg.split('=')[0] ?? arg;
  if (GLOBAL_BOOLEAN_FLAGS.includes(name)) return 1;
  if (!GLOBAL_VALUE_FLAGS.includes(name)) return 0;
  if (arg.includes('=')) return 1;
  return index + 1 < args.length ? 2 : 0;
};

/** Collects the run of global flags at the start of `args`; `end` is the index after it. */
const leadingGlobalFlags = (
  args: ReadonlyArray<string>,
  start = 0,
  hoisted: ReadonlyArray<string> = [],
): { readonly hoisted: ReadonlyArray<string>; readonly end: number } => {
  const width = globalFlagWidth(args, start);
  return width === 0
    ? { hoisted, end: start }
    : leadingGlobalFlags(args, start + width, [
        ...hoisted,
        ...args.slice(start, start + width),
      ]);
};

/**
 * The CLI framework only accepts a command's flags after the command token, so
 * `traces --config x services` is moved to `traces services --config x`.
 * Anything else before the command (`--help`, unknown flags) stops the scan
 * and leaves the arguments untouched.
 */
export const hoistGlobalFlags = (
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const leading = leadingGlobalFlags(args);
  const command = args[leading.end];
  if (
    leading.hoisted.length === 0 ||
    command === undefined ||
    command.startsWith('-')
  ) {
    return args;
  }
  return [command, ...leading.hoisted, ...args.slice(leading.end + 1)];
};
